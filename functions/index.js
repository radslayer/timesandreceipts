const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Busboy = require("busboy");
const { GoogleGenerativeAI } = require("@google/generative-ai");
admin.initializeApp();

exports.inviteUser = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Not signed in.");
  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = (callerDoc.data()?.role || "").toLowerCase();
  if (callerRole !== "admin") throw new HttpsError("permission-denied", "Admins only.");
  const { name, email, role } = request.data;
  if (!name || !email || !role) throw new HttpsError("invalid-argument", "Name, email, and role are required.");
  const tempPassword = Math.random().toString(36).slice(-10) + "A1!";
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email, password: tempPassword, displayName: name });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      userRecord = await admin.auth().getUserByEmail(email);
    } else {
      throw new HttpsError("internal", e.message);
    }
  }
  await admin.firestore().collection("users").doc(userRecord.uid).set({
    name, email, role, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  const link = await admin.auth().generatePasswordResetLink(email);
  await admin.firestore().collection("inviteEmails").add({
    to: email,
    message: {
      subject: "You're invited to MOTIF Lotus",
      html: `<p>Hi ${name},</p><p>You've been added to the MOTIF Lotus app. Click the link below to set your password and get started:</p><p><a href="${link}">${link}</a></p><p>Once you've set your password, sign in at: <a href="https://lotus.upshiftholdings.com">lotus.upshiftholdings.com</a></p><p>— MOTIF Design Solutions</p>`
    }
  });
  return { success: true };
});

exports.deactivateUser = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Not signed in.");
  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = (callerDoc.data()?.role || "").toLowerCase();
  if (callerRole !== "admin") throw new HttpsError("permission-denied", "Admins only.");
  const { uid, deactivate } = request.data;
  if (!uid) throw new HttpsError("invalid-argument", "User ID required.");
  await admin.auth().updateUser(uid, { disabled: deactivate });
  return { success: true };
});

// ── CLOCK-OUT REMINDER ────────────────────────────────────────────────────────
// Runs every 30 minutes. Finds active sessions between 8 and 8.5 hours old and
// emails the user a reminder (the 30-min window + the app's own client-side
// warning at 8h keep this from double-sending on every run).
exports.sendClockOutReminder = onSchedule("every 30 minutes", async (event) => {
  const db = admin.firestore();
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const eightPointFiveHoursAgo = new Date(Date.now() - 8.5 * 60 * 60 * 1000);

  const snapshot = await db.collection("timeLogs")
    .where("status", "==", "active")
    .where("clockIn", "<=", admin.firestore.Timestamp.fromDate(eightHoursAgo))
    .where("clockIn", ">=", admin.firestore.Timestamp.fromDate(eightPointFiveHoursAgo))
    .get();

  if (snapshot.empty) {
    console.log("No active sessions older than 8 hours found.");
    return;
  }

  const promises = snapshot.docs.map(async (doc) => {
    const session = doc.data();
    const userId = session.userId;
    if (!userId) return;

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return;
    const user = userDoc.data();
    const email = user.email;
    if (!email) return;

    const clockInTime = session.clockIn.toDate();
    const clockInFormatted = clockInTime.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true
    });

    console.log(`Sending clock-out reminder to ${email} for session started ${clockInFormatted}`);

    await db.collection("inviteEmails").add({
      to: email,
      message: {
        subject: "MOTIF — Did you forget to clock out?",
        html: `<p>Hi ${user.name || "there"},</p>
<p>You clocked in on <strong>${session.projectName || "a project"}</strong> at <strong>${clockInFormatted}</strong> and are still showing as active.</p>
<p>If you forgot to clock out, you can do so now:</p>
<p><a href="https://lotus.upshiftholdings.com" style="background:#4a7c59;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Open the app to clock out</a></p>
<p>If you already clocked out and this is an error, please contact your administrator.</p>
<p>— MOTIF Lotus</p>`
      }
    });
  });

  await Promise.all(promises);
  console.log(`Sent ${snapshot.docs.length} clock-out reminder(s).`);
});

// ── EMAILED RECEIPT INTAKE ──────────────────────────────────────────────────
// Public webhook that Mailgun's Inbound Route POSTs to whenever mail arrives
// at lotus@mail.upshiftholdings.com. Anyone can hit this URL, so every request
// is verified two ways before anything is trusted:
//   1. Mailgun's HMAC signature (proves the request actually came from Mailgun)
//   2. The sender's email must match an existing MOTIF staff account
// Attachments land in Storage and a summary doc lands in the `emailTriage`
// collection with status "pending" for a human to review in the app and
// convert into a real receipt (assigning project + cost code there, same as
// today's manual submit flow).
const mailgunSigningKey = defineSecret("MAILGUN_SIGNING_KEY");

function verifyMailgunSignature(signingKey, timestamp, token, signature) {
  if (!timestamp || !token || !signature) return false;
  // Reject stale requests (>15 min old) to limit replay window.
  const ts = parseInt(timestamp, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 15 * 60) return false;
  const expected = crypto.createHmac("sha256", signingKey).update(timestamp + token).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch (e) {
    return false;
  }
}

function parseMailgunMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

    bb.on("field", (name, val) => {
      fields[name] = val;
    });

    bb.on("file", (name, fileStream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      fileStream.on("data", (chunk) => chunks.push(chunk));
      fileStream.on("limit", () => {
        console.warn(`Attachment ${filename} exceeded size limit, truncated.`);
      });
      fileStream.on("close", () => {
        files.push({ filename: filename || `attachment-${files.length + 1}`, mimeType: mimeType || "application/octet-stream", buffer: Buffer.concat(chunks) });
      });
    });

    bb.on("error", reject);
    bb.on("close", () => resolve({ fields, files }));

    if (req.rawBody) {
      bb.end(req.rawBody);
    } else {
      req.pipe(bb);
    }
  });
}

exports.receiveEmailReceipt = onRequest({ secrets: [mailgunSigningKey], cors: false, region: "us-central1" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  let fields, files;
  try {
    ({ fields, files } = await parseMailgunMultipart(req));
  } catch (e) {
    console.error("Failed to parse inbound email payload:", e);
    res.status(400).send("Bad request");
    return;
  }

  // 1. Verify this really is Mailgun.
  const signingKey = mailgunSigningKey.value();
  const validSignature = verifyMailgunSignature(signingKey, fields.timestamp, fields.token, fields.signature);
  if (!validSignature) {
    // TEMP DIAGNOSTIC: log which piece is missing/bad without ever logging the
    // secret key itself, so we can tell "Mailgun isn't sending these fields at
    // all" apart from "fields are present but don't match the configured key."
    const ts = parseInt(fields.timestamp, 10);
    const ageSec = ts ? Math.abs(Date.now() / 1000 - ts) : null;
    console.warn("Rejected inbound email: invalid or missing Mailgun signature.", {
      hasTimestamp: !!fields.timestamp,
      hasToken: !!fields.token,
      hasSignature: !!fields.signature,
      timestampAgeSeconds: ageSec,
      signingKeyLength: signingKey ? signingKey.length : 0,
      signatureLength: fields.signature ? fields.signature.length : 0,
      allFieldNames: Object.keys(fields),
    });
    res.status(401).send("Invalid signature");
    return;
  }

  // 2. Verify the sender is a known MOTIF staff account.
  const fromEmail = (fields.sender || "").trim().toLowerCase();
  if (!fromEmail) {
    res.status(400).send("Missing sender");
    return;
  }
  const db = admin.firestore();
  const staffSnap = await db.collection("users").where("email", "==", fromEmail).limit(1).get();
  if (staffSnap.empty) {
    console.warn(`Rejected inbound email from unrecognized sender: ${fromEmail}`);
    // Return 200 so Mailgun doesn't retry — this isn't a transient failure, it's a permanent rejection.
    res.status(200).send("Sender not recognized, discarded.");
    return;
  }
  const staffUser = staffSnap.docs[0].data();
  if (staffUser.deactivated === true) {
    console.warn(`Rejected inbound email from deactivated account: ${fromEmail}`);
    res.status(200).send("Sender deactivated, discarded.");
    return;
  }

  // 3. Store attachments (if any) in Storage under emailTriage/<docId>/...
  // A download token is set on each file's metadata (the same mechanism the client
  // SDK's uploadBytes()/getDownloadURL() uses for the existing receipt/bill uploads),
  // so the resulting URL works directly with the app's existing image/PDF viewer —
  // no new Storage rules or signed-URL plumbing needed.
  const docRef = db.collection("emailTriage").doc();
  const bucket = admin.storage().bucket();
  const attachments = [];
  for (const file of files) {
    if (!file.buffer || !file.buffer.length) continue;
    const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `emailTriage/${docRef.id}/${Date.now()}_${safeName}`;
    const storageFile = bucket.file(storagePath);
    const downloadToken = crypto.randomUUID();
    await storageFile.save(file.buffer, {
      metadata: { contentType: file.mimeType, metadata: { firebaseStorageDownloadTokens: downloadToken } },
      resumable: false,
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;
    attachments.push({ filename: file.filename, mimeType: file.mimeType, storagePath, size: file.buffer.length, url });
  }

  // 4. Create the triage record for a human to review in the app.
  await docRef.set({
    fromEmail,
    fromName: staffUser.name || fromEmail,
    subject: fields.subject || "(no subject)",
    bodyPreview: (fields["body-plain"] || "").slice(0, 1000),
    attachments,
    status: "pending",
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Filed emailTriage/${docRef.id} from ${fromEmail} with ${attachments.length} attachment(s).`);
  res.status(200).send("OK");
});

// ── RECEIPT OCR (line-item extraction) ──────────────────────────────────────
// Lets staff pull structured line items off a receipt/invoice photo instead of
// keying the whole thing under one cost code. Called from the Submit Receipt,
// Add Bill, and Email Triage convert modals — always optional, always defaults
// back to the existing single-line-item behavior if the user doesn't use it.
const geminiApiKey = defineSecret("GEMINI_API_KEY");

const OCR_PROMPT = `You are reading a photo or scan of a receipt or invoice for a home
remodeling/construction company. Extract the following as JSON ONLY (no markdown fences,
no commentary, just the raw JSON object):

{
  "vendor": string or null,
  "date": "YYYY-MM-DD" or null,
  "total": number or null,
  "lineItems": [
    { "description": string, "amount": number }
  ]
}

Rules:
- Each purchased item or service should be its own line item with its own amount.
- If sales tax is shown as its own line on the receipt, include it as a line item named "Tax".
- If a delivery/shipping fee is shown, include it as its own line item named "Delivery" or "Shipping".
- Do not invent line items that aren't on the receipt. If you can only make out the total and
  not individual items, return an empty lineItems array with "total" set.
- Amounts are numbers, not strings, no currency symbols.
- If you cannot read the image at all, return {"vendor":null,"date":null,"total":null,"lineItems":[]}.`;

exports.ocrReceipt = onCall({ secrets: [geminiApiKey] }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Not signed in.");
  const { imageUrl, imageBase64, mimeType } = request.data || {};
  if ((!imageUrl || typeof imageUrl !== "string") && (!imageBase64 || typeof imageBase64 !== "string")) {
    throw new HttpsError("invalid-argument", "Either imageUrl or imageBase64 is required.");
  }

  let buffer, contentType;
  if (imageBase64) {
    try {
      buffer = Buffer.from(imageBase64, "base64");
      contentType = (typeof mimeType === "string" && mimeType) || "image/jpeg";
    } catch (e) {
      console.error("Failed to decode base64 receipt image for OCR:", e);
      throw new HttpsError("invalid-argument", "Could not decode the uploaded image.");
    }
  } else {
    try {
      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`Fetch failed with status ${resp.status}`);
      contentType = resp.headers.get("content-type") || "image/jpeg";
      buffer = Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      console.error("Failed to fetch receipt image for OCR:", e);
      throw new HttpsError("internal", "Could not fetch the receipt image.");
    }
  }

  // PDFs and images both work as inline data for Gemini's vision models.
  if (buffer.length > 15 * 1024 * 1024) {
    throw new HttpsError("invalid-argument", "File is too large to scan (15MB limit).");
  }

  let text;
  try {
    const genAI = new GoogleGenerativeAI(geminiApiKey.value());
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
    const result = await model.generateContent([
      OCR_PROMPT,
      { inlineData: { data: buffer.toString("base64"), mimeType: contentType } },
    ]);
    text = result.response.text();
  } catch (e) {
    console.error("Gemini OCR call failed:", e);
    throw new HttpsError("internal", "The AI scan failed. You can still enter this receipt manually.");
  }

  let parsed;
  try {
    const cleaned = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("Failed to parse OCR JSON. Raw response:", text);
    throw new HttpsError("internal", "Couldn't read a clear result from the scan. Try entering it manually.");
  }

  const lineItems = Array.isArray(parsed.lineItems)
    ? parsed.lineItems
        .filter((li) => li && typeof li.amount === "number" && !Number.isNaN(li.amount))
        .map((li) => ({ description: String(li.description || "Item").slice(0, 200), amount: Math.round(li.amount * 100) / 100 }))
    : [];

  return {
    vendor: typeof parsed.vendor === "string" ? parsed.vendor.slice(0, 200) : null,
    date: typeof parsed.date === "string" ? parsed.date : null,
    total: typeof parsed.total === "number" && !Number.isNaN(parsed.total) ? Math.round(parsed.total * 100) / 100 : null,
    lineItems,
  };
});
