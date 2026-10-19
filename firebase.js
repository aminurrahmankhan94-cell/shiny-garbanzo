import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
  updateProfile as updateAuthProfile
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

import {
  getDatabase,
  ref,
  get,
  set,
  update,
  push,
  onValue,
  runTransaction,
  query,
  orderByChild,
  limitToLast,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js";

import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js";

import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-functions.js";

// Firebase project configuration.
// Deploy the matching database and storage rules before using the app.

const firebaseConfig = {
  apiKey: "AIzaSyBbvQfpdM7-WzbYrn2WfygvPS2iRVaEMHY",
  authDomain: "emarni-chat.firebaseapp.com",
  databaseURL: "https://emarni-chat-default-rtdb.firebaseio.com/",
  projectId: "emarni-chat",
  storageBucket: "emarni-chat.firebasestorage.app",
  messagingSenderId: "787575452024",
  appId: "1:787575452024:web:11fc477a865cb8b8b8588d",
  measurementId: "G-DVV3E0FHLV"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const storage = getStorage(app);
const functions = getFunctions(app);

let currentUser = null;
let authHasResolved = false;

const authCallbacks = new Set();

onAuthStateChanged(auth, async user => {
  if (user?.isAnonymous) {
    // Older versions used anonymous sign-in.
    // This version requires a registered account.
    await signOut(auth).catch(() => {});
    return;
  }

  currentUser = user || null;
  authHasResolved = true;

  for (const callback of authCallbacks) {
    callback(currentUser);
  }
});

export function watchAuth(callback) {
  authCallbacks.add(callback);

  if (authHasResolved) {
    callback(currentUser);
  }

  return () => authCallbacks.delete(callback);
}

export function getCurrentUser() {
  return currentUser;
}

export async function registerAccount({
  email,
  password,
  displayName
}) {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(
      "emarni-pending-signup-name",
      displayName.trim().slice(0, 32)
    );
  }

  const credential = await createUserWithEmailAndPassword(
    auth,
    email.trim(),
    password
  );

  await updateAuthProfile(credential.user, {
    displayName: displayName.trim().slice(0, 32)
  });

  await ensureUserProfile(credential.user, displayName);

  return credential.user;
}

export async function signInAccount(login, password) {
  const value = String(login || "").trim();

  let credential;

  if (value.includes("@")) {
    credential = await signInWithEmailAndPassword(
      auth,
      value,
      password
    );
  } else {
    const signInById = httpsCallable(
      functions,
      "signInWithEmarniId"
    );

    const result = await signInById({
      emarniId: value.toUpperCase(),
      password
    });

    credential = await signInWithCustomToken(
      auth,
      result.data.customToken
    );
  }

  await ensureUserProfile(
    credential.user,
    (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("emarni-pending-signup-name")
    ) ||
    credential.user.displayName ||
    ""
  );

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("emarni-pending-signup-name");
  }

  return credential.user;
}

export function signOutAccount() {
  return signOut(auth);
}

function makeEmarniId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "EM";

  for (let i = 0; i < 8; i += 1) {
    result += chars[
      Math.floor(Math.random() * chars.length)
    ];
  }

  return result;
}

export async function ensureUserProfile(
  user,
  preferredName = ""
) {
  if (!user) {
    throw new Error("Sign in before opening a profile.");
  }

  const profileRef = ref(db, `users/${user.uid}/profile`);

  const pendingName =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("emarni-pending-signup-name")
      : "";

  const initialName = (
    pendingName ||
    preferredName ||
    user.displayName ||
    user.email?.split("@")[0] ||
    "Emarni user"
  ).trim().slice(0, 32);

  const transaction = await runTransaction(
    profileRef,
    current => {
      if (current) return current;

      return {
        uid: user.uid,
        emarniId: makeEmarniId(),
        displayName:
          initialName.length >= 2
            ? initialName
            : "Emarni user",
        bio: "",
        photoURL: "",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    },
    { applyLocally: false }
  );

  if (
    !transaction.committed ||
    !transaction.snapshot.exists()
  ) {
    throw new Error("Could not initialise your profile.");
  }

  const profile = transaction.snapshot.val();

  const publicRef = ref(
    db,
    `userDirectory/${profile.emarniId}`
  );

  const publicSnapshot = await get(publicRef);

  if (
    !publicSnapshot.exists() ||
    publicSnapshot.val()?.uid === user.uid
  ) {
    await set(publicRef, {
      uid: user.uid,
      emarniId: profile.emarniId,
      displayName: profile.displayName,
      bio: profile.bio || "",
      photoURL: profile.photoURL || "",
      createdAt: profile.createdAt || Date.now()
    });
  }

  if (user.displayName !== profile.displayName) {
    await updateAuthProfile(user, {
      displayName: profile.displayName
    }).catch(() => {});
  }

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("emarni-pending-signup-name");
  }

  return profile;
}

export async function saveUserProfile({
  displayName,
  bio,
  photoURL
}) {
  if (!currentUser) {
    throw new Error("You are signed out.");
  }

  const profileRef = ref(
    db,
    `users/${currentUser.uid}/profile`
  );

  const snapshot = await get(profileRef);

  if (!snapshot.exists()) {
    throw new Error("Your profile has not loaded yet.");
  }

  const oldProfile = snapshot.val();

  const profile = {
    ...oldProfile,
    displayName: String(displayName || "").trim().slice(0, 32),
    bio: String(bio || "").trim().slice(0, 160),
    photoURL:
      photoURL === undefined
        ? (oldProfile.photoURL || "")
        : photoURL,
    updatedAt: Date.now()
  };

  if (profile.displayName.length < 2) {
    throw new Error(
      "Your display name must have at least 2 characters."
    );
  }

  await update(profileRef, {
    displayName: profile.displayName,
    bio: profile.bio,
    photoURL: profile.photoURL,
    updatedAt: profile.updatedAt
  });

  await set(
    ref(db, `userDirectory/${profile.emarniId}`),
    {
      uid: currentUser.uid,
      emarniId: profile.emarniId,
      displayName: profile.displayName,
      bio: profile.bio,
      photoURL: profile.photoURL,
      createdAt: profile.createdAt || Date.now()
    }
  );

  await updateAuthProfile(currentUser, {
    displayName: profile.displayName,
    photoURL: profile.photoURL || null
  }).catch(() => {});

  return profile;
}

export async function uploadAvatar(file) {
  if (!currentUser) {
    throw new Error(
      "Sign in before uploading a profile photo."
    );
  }

  if (!file) return "";

  const validTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!validTypes.includes(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image.");
  }

  if (file.size > 5 * 1024 * 1024) {
    throw new Error(
      "Profile photos must be 5 MB or smaller."
    );
  }

  const extension =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
      ? "webp"
      : "jpg";

  const target = storageRef(
    storage,
    `avatars/${currentUser.uid}/profile-${Date.now()}.${extension}`
  );

  await uploadBytes(target, file, {
    contentType: file.type,
    cacheControl: "public,max-age=3600"
  });

  return getDownloadURL(target);
}

export function watchUserDirectory(callback, onError) {
  return onValue(
    ref(db, "userDirectory"),
    snapshot => callback(snapshot.val() || {}),
    error => onError?.(error)
  );
}

export function watchFriendships(uid, callback, onError) {
  return onValue(
    ref(db, `friendships/${uid}`),
    snapshot => callback(snapshot.val() || {}),
    error => onError?.(error)
  );
}

export function watchIncomingRequests(uid, callback, onError) {
  return onValue(
    ref(db, `friendRequests/${uid}`),
    snapshot => callback(snapshot.val() || {}),
    error => onError?.(error)
  );
}

export async function sendFriendRequest(recipientUid, profile) {
  if (!currentUser) {
    throw new Error(
      "Sign in before sending friend requests."
    );
  }

  if (
    !recipientUid ||
    recipientUid === currentUser.uid
  ) {
    throw new Error(
      "You cannot send a friend request to yourself."
    );
  }

  const existing = await get(
    ref(db, `friendships/${currentUser.uid}/${recipientUid}`)
  );

  if (existing.val()?.status === "accepted") {
    throw new Error("You are already friends.");
  }

  const requestRef = ref(
    db,
    `friendRequests/${recipientUid}/${currentUser.uid}`
  );

  await set(requestRef, {
    fromUid: currentUser.uid,
    fromEmarniId: profile.emarniId,
    fromName: profile.displayName,
    status: "pending",
    createdAt: Date.now()
  });
}

export async function respondFriendRequest(
  requesterUid,
  accept
) {
  if (!currentUser) {
    throw new Error(
      "Sign in before responding to requests."
    );
  }

  const requestRef = ref(
    db,
    `friendRequests/${currentUser.uid}/${requesterUid}`
  );

  const requestSnapshot = await get(requestRef);

  if (
    !requestSnapshot.exists() ||
    requestSnapshot.val()?.status !== "pending"
  ) {
    throw new Error(
      "This friend request is no longer available."
    );
  }

  await update(requestRef, {
    status: accept ? "accepted" : "declined",
    respondedAt: Date.now()
  });

  if (accept) {
    const relationship = {
      status: "accepted",
      since: Date.now()
    };

    await update(ref(db), {
      [`friendships/${currentUser.uid}/${requesterUid}`]: relationship,
      [`friendships/${requesterUid}/${currentUser.uid}`]: relationship
    });
  }
}

export async function openPrivateChat(otherUid) {
  const fn = httpsCallable(functions, "openPrivateChat");
  const result = await fn({ otherUid });
  return result.data.roomId;
}

export async function createChatGroup({
  name,
  type,
  description,
  companyName,
  website,
  memberUids
}) {
  const fn = httpsCallable(functions, "createChatGroup");

  const result = await fn({
    name,
    type,
    description,
    companyName,
    website,
    memberUids
  });

  return result.data.groupId;
}

export function watchMyGroups(uid, callback, onError) {
  return onValue(
    ref(db, `userGroups/${uid}`),
    async snapshot => {
      const ids = Object.keys(snapshot.val() || {});

      try {
        const records = await Promise.all(
          ids.map(async id => {
            const groupSnapshot = await get(
              ref(db, `groups/${id}`)
            );

            return groupSnapshot.exists()
              ? { id, ...groupSnapshot.val() }
              : null;
          })
        );

        callback(
          records
            .filter(Boolean)
            .sort((a, b) =>
              (b.createdAt || 0) - (a.createdAt || 0)
            )
        );
      } catch (error) {
        onError?.(error);
      }
    },
    error => onError?.(error)
  );
}

function messagePath(chat) {
  if (chat.type === "global" || chat.type === "support") {
    return `rooms/${chat.type}/messages`;
  }

  if (chat.type === "private") {
    return `privateRooms/${chat.id}/messages`;
  }

  if (chat.type === "group") {
    return `groups/${chat.id}/messages`;
  }

  throw new Error("Unknown chat room.");
}

export function watchMessages(chat, callback, onError) {
  const messagesQuery = query(
    ref(db, messagePath(chat)),
    orderByChild("createdAt"),
    limitToLast(100)
  );

  return onValue(
    messagesQuery,
    snapshot => {
      const messages = [];

      snapshot.forEach(child => {
        messages.push({
          id: child.key,
          ...child.val()
        });
      });

      messages.sort(
        (a, b) =>
          (Number(a.createdAt) || 0) -
          (Number(b.createdAt) || 0)
      );

      callback(messages);
    },
    error => onError?.(error)
  );
}

export async function sendChatMessage(chat, text, profile) {
  if (!currentUser) {
    throw new Error("Sign in before sending a message.");
  }

  const cleanText = String(text || "").trim();

  if (!cleanText) {
    throw new Error("Write a message first.");
  }

  if (cleanText.length > 1000) {
    throw new Error(
      "Messages can contain up to 1,000 characters."
    );
  }

  const messagesRef = ref(db, messagePath(chat));
  const newMessageRef = push(messagesRef);

  await set(newMessageRef, {
    uid: currentUser.uid,
    senderName: String(
      profile?.displayName ||
      currentUser.displayName ||
      "Emarni user"
    ).slice(0, 32),
    senderEmarniId: String(profile?.emarniId || ""),
    senderPhotoURL: String(profile?.photoURL || ""),
    text: cleanText,
    deleted: false,
    createdAt: serverTimestamp()
  });

  return newMessageRef.key;
}

export async function deleteChatMessage(chat, messageId) {
  const fn = httpsCallable(functions, "deleteChatMessage");

  const result = await fn({
    roomType: chat.type,
    roomId: chat.id,
    messageId
  });

  return result.data;
}

export async function reportChatMessage(chat, messageId, reason) {
  const fn = httpsCallable(functions, "reportChatMessage");

  const result = await fn({
    roomType: chat.type,
    roomId: chat.id,
    messageId,
    reason
  });

  return result.data;
}

export async function resolveModerationReport(reportId) {
  const fn = httpsCallable(
    functions,
    "resolveModerationReport"
  );

  const result = await fn({ reportId });

  return result.data;
}

export async function checkAdminRole(user) {
  if (!user) return false;

  const token = await user.getIdTokenResult(true);

  return token.claims.admin === true;
}

export function watchModerationArchive(callback, onError) {
  return onValue(
    ref(db, "moderationArchive"),
    snapshot => callback(snapshot.val() || {}),
    error => onError?.(error)
  );
}

export function watchModerationReports(callback, onError) {
  return onValue(
    ref(db, "moderationReports"),
    snapshot => callback(snapshot.val() || {}),
    error => onError?.(error)
  );
}

export function watchBannedUsers(callback, onError) {
  return onValue(
    ref(db, "banned"),
    snapshot => callback(snapshot.val() || {}),
    error => onError?.(error)
  );
}

export async function setUserBan(uid, banned) {
  const fn = httpsCallable(functions, "setUserBanned");

  const result = await fn({
    targetUid: uid,
    banned: Boolean(banned)
  });

  return result.data;
}
