const admin = require("firebase-admin");

const uid = process.argv[2];

if (!uid) {
  console.error(
    "Usage: node functions/set-admin.js YOUR_FIREBASE_AUTH_UID"
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || "emarni-chat"
});

async function main() {
  const user = await admin.auth().getUser(uid);

  await admin.auth().setCustomUserClaims(uid, {
    ...(user.customClaims || {}),
    admin: true
  });

  console.log(
    `Admin access enabled for Firebase UID: ${uid}`
  );

  await admin.app().delete();
}

main().catch(async error => {
  console.error("Could not set admin access:", error);

  try {
    await admin.app().delete();
  } catch {
    // Firebase Admin may not have finished initialising.
  }

  process.exitCode = 1;
});
