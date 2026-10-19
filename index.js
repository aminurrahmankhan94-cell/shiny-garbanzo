const admin = require("firebase-admin");
const crypto = require("node:crypto");

const {
  onCall,
  HttpsError
} = require("firebase-functions/v2/https");

const {
  onSchedule
} = require("firebase-functions/v2/scheduler");

admin.initializeApp();

const db = admin.database();

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Sign in to continue."
    );
  }

  return request.auth;
}

function requireAdmin(request) {
  const auth = requireAuth(request);

  if (auth.token.admin !== true) {
    throw new HttpsError(
      "permission-denied",
      "Administrator access is required."
    );
  }

  return auth;
}

async function ensureNotBanned(uid, isAdmin = false) {
  if (isAdmin) return;

  const banned = await db.ref(`banned/${uid}`).get();

  if (banned.exists()) {
    throw new HttpsError(
      "permission-denied",
      "This account has been restricted."
    );
  }
}

const FIREBASE_WEB_API_KEY =
  process.env.EMARNI_FIREBASE_WEB_API_KEY ||
  "AIzaSyBbvQfpdM7-WzbYrn2WfygvPS2iRVaEMHY";

async function applyLoginIdRateLimit(request) {
  const clientIp = String(
    request.rawRequest?.ip ||
    request.rawRequest?.headers?.["x-forwarded-for"] ||
    "unknown"
  ).split(",")[0].trim();

  const bucketId = crypto
    .createHash("sha256")
    .update(clientIp)
    .digest("hex")
    .slice(0, 32);

  const bucketRef = db.ref(
    `loginAttemptBuckets/${bucketId}`
  );

  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 20;

  const transaction = await bucketRef.transaction(
    current => {
      const attempts = (
        Array.isArray(current?.attempts)
          ? current.attempts
          : []
      ).filter(value => Number(value) > now - windowMs);

      if (attempts.length >= maxAttempts) return;

      attempts.push(now);

      return {
        attempts,
        updatedAt: now
      };
    },
    undefined,
    false
  );

  if (!transaction.committed) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many sign-in attempts. Please wait 15 minutes and try again."
    );
  }
}

exports.signInWithEmarniId = onCall(async request => {
  const emarniId = String(
    request.data?.emarniId || ""
  ).trim().toUpperCase();

  const password = String(request.data?.password || "");

  if (
    !/^EM[A-HJ-NP-Z2-9]{8}$/.test(emarniId) ||
    password.length < 1 ||
    password.length > 256
  ) {
    throw new HttpsError(
      "unauthenticated",
      "The Emarni ID or password is not correct."
    );
  }

  await applyLoginIdRateLimit(request);

  const publicProfile = await db
    .ref(`userDirectory/${emarniId}/uid`)
    .get();

  if (!publicProfile.exists()) {
    throw new HttpsError(
      "unauthenticated",
      "The Emarni ID or password is not correct."
    );
  }

  let userRecord;

  try {
    userRecord = await admin.auth().getUser(
      String(publicProfile.val())
    );
  } catch {
    throw new HttpsError(
      "unauthenticated",
      "The Emarni ID or password is not correct."
    );
  }

  if (!userRecord.email) {
    throw new HttpsError(
      "failed-precondition",
      "This account does not have an email sign-in method."
    );
  }

  let response;

  try {
    response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: userRecord.email,
          password,
          returnSecureToken: true
        })
      }
    );
  } catch {
    throw new HttpsError(
      "unavailable",
      "Authentication is temporarily unavailable. Try again soon."
    );
  }

  const authResult = await response.json().catch(() => ({}));

  if (
    !response.ok ||
    authResult.localId !== userRecord.uid
  ) {
    throw new HttpsError(
      "unauthenticated",
      "The Emarni ID or password is not correct."
    );
  }

  const customToken = await admin.auth().createCustomToken(
    userRecord.uid,
    userRecord.customClaims || {}
  );

  return { customToken };
});

async function areAcceptedFriends(uidA, uidB) {
  const [a, b] = await Promise.all([
    db.ref(`friendships/${uidA}/${uidB}/status`).get(),
    db.ref(`friendships/${uidB}/${uidA}/status`).get()
  ]);

  return (
    a.val() === "accepted" &&
    b.val() === "accepted"
  );
}

exports.openPrivateChat = onCall(async request => {
  const auth = requireAuth(request);

  await ensureNotBanned(
    auth.uid,
    auth.token.admin === true
  );

  const otherUid = String(
    request.data?.otherUid || ""
  );

  if (!otherUid || otherUid === auth.uid) {
    throw new HttpsError(
      "invalid-argument",
      "Choose another user."
    );
  }

  if (!(await areAcceptedFriends(auth.uid, otherUid))) {
    throw new HttpsError(
      "permission-denied",
      "A private chat is available only after both users are accepted friends."
    );
  }

  const memberIds = [auth.uid, otherUid].sort();
  const roomId = memberIds.join("__");

  const roomRef = db.ref(`privateRooms/${roomId}`);
  const snapshot = await roomRef.get();

  if (!snapshot.exists()) {
    const now = Date.now();

    await roomRef.set({
      members: {
        [memberIds[0]]: true,
        [memberIds[1]]: true
      },
      createdAt: now,
      createdBy: auth.uid
    });
  } else {
    const members = snapshot.child("members").val() || {};

    if (!members[auth.uid] || !members[otherUid]) {
      throw new HttpsError(
        "permission-denied",
        "You are not a member of this conversation."
      );
    }
  }

  return { roomId };
});

exports.createChatGroup = onCall(async request => {
  const auth = requireAuth(request);

  await ensureNotBanned(
    auth.uid,
    auth.token.admin === true
  );

  const data = request.data || {};

  const name = String(data.name || "").trim().slice(0, 55);

  const type =
    data.type === "business"
      ? "business"
      : "community";

  const description = String(
    data.description || ""
  ).trim().slice(0, 240);

  const companyName =
    type === "business"
      ? String(data.companyName || "").trim().slice(0, 80)
      : "";

  const website =
    type === "business"
      ? String(data.website || "").trim().slice(0, 160)
      : "";

  if (name.length < 2) {
    throw new HttpsError(
      "invalid-argument",
      "Group name must contain at least 2 characters."
    );
  }

  if (website) {
    try {
      const parsed = new URL(website);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      throw new HttpsError(
        "invalid-argument",
        "Enter a valid business website URL."
      );
    }
  }

  const invited = Array.isArray(data.memberUids)
    ? [
        ...new Set(
          data.memberUids
            .map(value => String(value))
            .filter(Boolean)
        )
      ]
    : [];

  if (invited.length > 49) {
    throw new HttpsError(
      "invalid-argument",
      "A group can invite up to 49 friends at a time."
    );
  }

  for (const uid of invited) {
    if (uid === auth.uid) continue;

    if (!(await areAcceptedFriends(auth.uid, uid))) {
      throw new HttpsError(
        "permission-denied",
        "You can invite accepted friends only."
      );
    }
  }

  const groupRef = db.ref("groups").push();
  const groupId = groupRef.key;
  const now = Date.now();

  const allMembers = [
    ...new Set([auth.uid, ...invited])
  ];

  const members = {};
  const indexes = {};

  for (const uid of allMembers) {
    members[uid] = {
      role: uid === auth.uid ? "owner" : "member",
      joinedAt: now
    };

    indexes[`userGroups/${uid}/${groupId}`] = true;
  }

  await db.ref().update({
    [`groups/${groupId}`]: {
      id: groupId,
      name,
      type,
      description,
      companyName,
      website,
      ownerUid: auth.uid,
      createdAt: now,
      members
    },
    ...indexes
  });

  return { groupId };
});
exports.deleteChatMessage = onCall(async request => {
  const auth = requireAuth(request);
  const isAdmin = auth.token.admin === true;

  await ensureNotBanned(auth.uid, isAdmin);

  const data = request.data || {};

  const roomType = String(data.roomType || "");
  const roomId = String(data.roomId || "");
  const messageId = String(data.messageId || "");

  if (
    !messageId ||
    !["global", "support", "private", "group"].includes(roomType)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid message reference."
    );
  }

  let messagePath;

  if (roomType === "global" || roomType === "support") {
    if (roomId !== roomType) {
      throw new HttpsError("invalid-argument", "Invalid room.");
    }

    messagePath = `rooms/${roomType}/messages/${messageId}`;
  } else if (roomType === "private") {
    if (!roomId) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid private room."
      );
    }

    messagePath = `privateRooms/${roomId}/messages/${messageId}`;

    const room = await db
      .ref(`privateRooms/${roomId}/members`)
      .get();

    if (!room.child(auth.uid).exists()) {
      throw new HttpsError(
        "permission-denied",
        "You are not a member of this private chat."
      );
    }
  } else {
    if (!roomId) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid group."
      );
    }

    messagePath = `groups/${roomId}/messages/${messageId}`;

    const member = await db
      .ref(`groups/${roomId}/members/${auth.uid}`)
      .get();

    if (!member.exists()) {
      throw new HttpsError(
        "permission-denied",
        "You are not a member of this group."
      );
    }
  }

  const messageRef = db.ref(messagePath);
  const snapshot = await messageRef.get();

  if (!snapshot.exists()) {
    throw new HttpsError(
      "not-found",
      "This message no longer exists."
    );
  }

  const message = snapshot.val();

  if (message.deleted === true) {
    return {
      deleted: true,
      alreadyDeleted: true
    };
  }

  if (message.uid !== auth.uid) {
    throw new HttpsError(
      "permission-denied",
      "You can delete only your own messages."
    );
  }

  const now = Date.now();
  const archiveRef = db.ref("moderationArchive").push();

  await archiveRef.set({
    roomType,
    roomId,
    messageId,
    message,
    deletedBy: auth.uid,
    deletedAt: now,
    expiresAt: now + RETENTION_MS
  });

  await messageRef.update({
    text: "",
    deleted: true,
    deletedAt: now,
    deletedBy: auth.uid
  });

  return {
    deleted: true,
    archiveExpiresAt: now + RETENTION_MS
  };
});

exports.reportChatMessage = onCall(async request => {
  const auth = requireAuth(request);

  await ensureNotBanned(
    auth.uid,
    auth.token.admin === true
  );

  const data = request.data || {};

  const roomType = String(data.roomType || "");
  const roomId = String(data.roomId || "");
  const messageId = String(data.messageId || "");
  const reason = String(data.reason || "").trim().slice(0, 200);

  if (
    !messageId ||
    reason.length < 3 ||
    !["global", "support", "private", "group"].includes(roomType)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Choose a message and include a short report reason."
    );
  }

  let messagePath;

  if (roomType === "global" || roomType === "support") {
    if (roomId !== roomType) {
      throw new HttpsError("invalid-argument", "Invalid room.");
    }

    messagePath = `rooms/${roomType}/messages/${messageId}`;
  } else if (roomType === "private") {
    messagePath = `privateRooms/${roomId}/messages/${messageId}`;

    const member = await db
      .ref(`privateRooms/${roomId}/members/${auth.uid}`)
      .get();

    if (!member.exists()) {
      throw new HttpsError(
        "permission-denied",
        "You are not a member of this conversation."
      );
    }
  } else {
    messagePath = `groups/${roomId}/messages/${messageId}`;

    const member = await db
      .ref(`groups/${roomId}/members/${auth.uid}`)
      .get();

    if (!member.exists()) {
      throw new HttpsError(
        "permission-denied",
        "You are not a member of this group."
      );
    }
  }

  const snapshot = await db.ref(messagePath).get();

  if (
    !snapshot.exists() ||
    snapshot.child("deleted").val() === true
  ) {
    throw new HttpsError(
      "not-found",
      "This message is not available for reporting."
    );
  }

  const message = snapshot.val();

  if (message.uid === auth.uid) {
    throw new HttpsError(
      "failed-precondition",
      "You cannot report your own message."
    );
  }

  const reportId = crypto
    .createHash("sha256")
    .update(`${roomType}|${roomId}|${messageId}|${auth.uid}`)
    .digest("hex");

  const reportRef = db.ref(`moderationReports/${reportId}`);
  const previous = await reportRef.get();

  if (previous.exists()) {
    return {
      reported: true,
      alreadyReported: true
    };
  }

  await reportRef.set({
    roomType,
    roomId,
    messageId,
    message,
    reporterUid: auth.uid,
    reason,
    status: "open",
    createdAt: Date.now()
  });

  return { reported: true };
});

exports.resolveModerationReport = onCall(async request => {
  const auth = requireAdmin(request);

  const reportId = String(request.data?.reportId || "");

  if (!/^[a-f0-9]{64}$/.test(reportId)) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid report reference."
    );
  }

  const reportRef = db.ref(`moderationReports/${reportId}`);
  const snapshot = await reportRef.get();

  if (!snapshot.exists()) {
    throw new HttpsError(
      "not-found",
      "This report no longer exists."
    );
  }

  await reportRef.update({
    status: "reviewed",
    reviewedAt: Date.now(),
    reviewedBy: auth.uid
  });

  return {
    reportId,
    status: "reviewed"
  };
});

exports.setUserBanned = onCall(async request => {
  const auth = requireAdmin(request);

  const targetUid = String(request.data?.targetUid || "");
  const shouldBan = Boolean(request.data?.banned);

  if (!targetUid) {
    throw new HttpsError(
      "invalid-argument",
      "Choose a target user."
    );
  }

  if (targetUid === auth.uid) {
    throw new HttpsError(
      "failed-precondition",
      "You cannot ban the currently signed-in administrator."
    );
  }

  const targetProfile = await db
    .ref(`users/${targetUid}/profile`)
    .get();

  if (!targetProfile.exists()) {
    throw new HttpsError(
      "not-found",
      "That user profile was not found."
    );
  }

  const banRef = db.ref(`banned/${targetUid}`);
  const previousBan = await banRef.get();

  if (shouldBan && previousBan.exists()) {
    return {
      uid: targetUid,
      banned: true,
      alreadyBanned: true
    };
  }

  if (!shouldBan && !previousBan.exists()) {
    return {
      uid: targetUid,
      banned: false,
      alreadyBanned: false
    };
  }

  if (shouldBan) {
    const targetRecord = await admin.auth().getUser(targetUid);

    await admin.auth().updateUser(targetUid, {
      disabled: true
    });

    await banRef.set({
      bannedAt: Date.now(),
      bannedBy: auth.uid,
      previouslyDisabled: Boolean(targetRecord.disabled)
    });
  } else {
    const restoreDisabledState = Boolean(
      previousBan.val()?.previouslyDisabled
    );

    await admin.auth().updateUser(targetUid, {
      disabled: restoreDisabledState
    });

    await banRef.remove();
  }

  return {
    uid: targetUid,
    banned: shouldBan
  };
});

exports.purgeExpiredModerationArchive = onSchedule(
  "every 60 minutes",
  async () => {
    const [archiveSnapshot, loginSnapshot] = await Promise.all([
      db.ref("moderationArchive").get(),
      db.ref("loginAttemptBuckets").get()
    ]);

    const now = Date.now();

    if (archiveSnapshot.exists()) {
      const archiveUpdates = {};

      archiveSnapshot.forEach(child => {
        const expiresAt = Number(
          child.child("expiresAt").val() || 0
        );

        if (expiresAt && expiresAt <= now) {
          archiveUpdates[child.key] = null;
        }
      });

      if (Object.keys(archiveUpdates).length) {
        await db.ref("moderationArchive").update(archiveUpdates);
      }
    }

    if (loginSnapshot.exists()) {
      const loginUpdates = {};

      loginSnapshot.forEach(child => {
        const updatedAt = Number(
          child.child("updatedAt").val() || 0
        );

        if (
          !updatedAt ||
          updatedAt < now - 24 * 60 * 60 * 1000
        ) {
          loginUpdates[child.key] = null;
        }
      });

      if (Object.keys(loginUpdates).length) {
        await db.ref("loginAttemptBuckets").update(loginUpdates);
      }
    }
  }
);
