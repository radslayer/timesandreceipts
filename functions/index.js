const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
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
      subject: "You're invited to MOTIF Times & Receipts",
      html: `<p>Hi ${name},</p><p>You've been added to the MOTIF Times & Receipts app. Click the link below to set your password and get started:</p><p><a href="${link}">${link}</a></p><p>Once you've set your password, sign in at: <a href="https://timesandreceipts.upshiftholdings.com">timesandreceipts.upshiftholdings.com</a></p><p>— MOTIF Design Solutions</p>`
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
<p><a href="https://timesandreceipts.upshiftholdings.com" style="background:#4a7c59;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Open the app to clock out</a></p>
<p>If you already clocked out and this is an error, please contact your administrator.</p>
<p>— MOTIF Times &amp; Receipts</p>`
      }
    });
  });

  await Promise.all(promises);
  console.log(`Sent ${snapshot.docs.length} clock-out reminder(s).`);
});
