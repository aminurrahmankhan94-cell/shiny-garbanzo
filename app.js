import {
  watchAuth,
  getCurrentUser,
  registerAccount,
  signInAccount,
  signOutAccount,
  ensureUserProfile,
  saveUserProfile,
  uploadAvatar,
  watchUserDirectory,
  watchFriendships,
  watchIncomingRequests,
  sendFriendRequest,
  respondFriendRequest,
  openPrivateChat,
  createChatGroup,
  watchMyGroups,
  watchMessages,
  sendChatMessage,
  deleteChatMessage,
  reportChatMessage,
  resolveModerationReport,
  checkAdminRole,
  watchModerationArchive,
  watchModerationReports,
  watchBannedUsers,
  setUserBan
} from "./firebase.js";

const $ = id => document.getElementById(id);

const state = {
  user: null,
  profile: null,
  isAdmin: false,
  adminUnlocked: false,
  directory: {},
  friendships: {},
  requests: {},
  groups: [],
  messages: [],
  archive: {},
  reports: {},
  banned: {},
  activeChat: {
    type: "global",
    id: "global",
    title: "Global Lounge",
    subtitle: "Join the conversation with the Emarni community."
  },
  activeView: "global",
  authMode: "signin",
  unsubscribers: [],
  messageUnsubscribe: null,
  archiveUnsubscribe: null,
  bannedUnsubscribe: null,
  reportsUnsubscribe: null,
  toastTimer: null,
  adminTab: "users"
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const el = (tag, className = "", text = undefined) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3600);
}

function connection(status, label) {
  $("connectionText").textContent = label;
  const dot = $("connectionIndicator");
  dot.classList.toggle("connected", status === "connected");
  dot.classList.toggle("offline", status === "offline");
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === "signup";

  $("signupNameWrap").classList.toggle("hidden", !signup);
  $("signupName").required = signup;
  $("authTitle").textContent = signup ? "Create your account" : "Welcome back";
  $("authSubmit").innerHTML = signup
    ? 'Create account <span class="button-arrow">→</span>'
    : 'Sign in <span class="button-arrow">→</span>';
  $("authSwitchText").textContent = signup ? "Already have an account?" : "New to Emarni?";
  $("authSwitch").textContent = signup ? "Sign in" : "Create an account";
}

function friendlyAuthError(error) {
  const code = error?.code || "";
  const messages = {
    "auth/email-already-in-use": "An account already uses this email address. Try signing in.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Choose a stronger password with at least 8 characters.",
    "auth/invalid-credential": "The email or password is not correct.",
    "auth/user-not-found": "No account was found for that email address.",
    "auth/wrong-password": "The email or password is not correct.",
    "auth/too-many-requests": "Too many attempts. Please try again later."
  };
  return messages[code] || error?.message || "Something went wrong. Please try again.";
}

function renderAvatar(target, name, photoURL, className = "") {
  target.replaceChildren();
  if (className) target.className = className;

  if (photoURL) {
    const image = el("img");
    image.src = photoURL;
    image.alt = `${name || "User"} profile`;
    image.loading = "lazy";
    image.onerror = () => {
      target.replaceChildren(document.createTextNode((name || "E").charAt(0).toUpperCase()));
    };
    target.appendChild(image);
  } else {
    target.textContent = (name || "E").trim().charAt(0).toUpperCase() || "E";
  }
}

function updateProfileUI() {
  const profile = state.profile || {};
  $("profileName").textContent = profile.displayName || "Your profile";
  $("profileEmarniId").textContent = profile.emarniId ? `@${profile.emarniId}` : "Creating ID...";

  renderAvatar($("profileAvatar"), profile.displayName, profile.photoURL, "avatar avatar-large");
  renderAvatar($("profilePreview"), profile.displayName, profile.photoURL, "avatar avatar-xl");
}

function updateRequestCount() {
  const count = Object.values(state.requests || {})
    .filter(request => request?.status === "pending").length;
  $("requestCount").textContent = String(count);
  $("requestCount").classList.toggle("hidden", count < 1);
}

function publicProfileByUid(uid) {
  return Object.values(state.directory).find(item => item?.uid === uid) || null;
}

function sortedFriends() {
  return Object.entries(state.friendships || {})
    .filter(([, value]) => value?.status === "accepted")
    .map(([uid]) => ({ uid, profile: publicProfileByUid(uid) }))
    .filter(entry => Boolean(entry.profile))
    .sort((a, b) => (a.profile.displayName || "").localeCompare(b.profile.displayName || ""));
}

function changeView(view) {
  if (view === "global") {
    activateChat({ type: "global", id: "global", title: "Global Lounge", subtitle: "Join the conversation with the Emarni community." });
    return;
  }

  state.activeView = view;
  if (state.messageUnsubscribe) {
    state.messageUnsubscribe();
    state.messageUnsubscribe = null;
  }

  $("chatWorkspace").classList.add("hidden");
  $("contentPanel").classList.remove("hidden");
  $("chatSearchStrip").classList.add("hidden");

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $("sidebar").classList.remove("open");

  if (view === "discover") renderDiscoverPanel();
  else if (view === "requests") renderRequestsPanel();
  else if (view === "friends") renderFriendsPanel();
}

function activateChat(chat) {
  state.activeChat = chat;
  state.activeView = chat.type;
  state.messages = [];

  if (state.messageUnsubscribe) state.messageUnsubscribe();
  state.messageUnsubscribe = null;

  $("contentPanel").classList.add("hidden");
  $("chatWorkspace").classList.remove("hidden");
  $("chatSearchStrip").classList.add("hidden");

  $("viewTitle").textContent = chat.title;
  $("viewSubtitle").textContent = chat.subtitle || "A place to share thoughtful messages.";
  $("headerOverline").textContent = chat.type === "private" ? "PRIVATE CONVERSATION" : chat.type === "group" ? "GROUP CONVERSATION" : "COMMUNITY CHAT";
  $("roomTypeBadge").textContent = chat.type === "private" ? "FRIENDS ONLY" : chat.type === "group" ? "GROUP CHAT" : "PUBLIC ROOM";
  $("conversationLabel").textContent = "LATEST MESSAGES";
  $("welcomeBanner").classList.toggle("hidden", chat.type !== "global");

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.view === chat.type);
  });
  $("sidebar").classList.remove("open");

  renderMessages();
  state.messageUnsubscribe = watchMessages(chat, messages => {
    state.messages = messages;
    if (chat.type === "global") $("welcomeBanner").classList.toggle("hidden", messages.length > 0);
    renderMessages();
  }, error => {
    console.error(error);
    showToast("Could not load messages.");
  });
}

function formatTime(value) {
  if (!value) return "just now";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "just now";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function createMessageRow(message) {
  const mine = Boolean(state.user && message.uid === state.user.uid);
  const row = el("article", `message-row${mine ? " mine" : ""}`);
  const avatar = el("div", "message-avatar");

  renderAvatar(avatar, message.senderName || "User", message.senderPhotoURL || "", "message-avatar");

  const content = el("div", "message-content");
  const meta = el("div", "message-meta");

  meta.append(
    el("strong", "", mine ? "You" : (message.senderName || "Emarni user")),
    el("span", "message-time", formatTime(message.createdAt))
  );

  const bubble = el("div", `message-bubble${message.deleted ? " deleted-bubble" : ""}`, message.deleted ? "This message was deleted." : (message.text || ""));
  content.append(meta, bubble);

  if (!message.deleted) {
    const actions = el("div", "message-actions");
    if (mine || state.adminUnlocked) {
      const removeButton = el("button", "message-action", "Delete");
      removeButton.type = "button";
      removeButton.addEventListener("click", async () => {
        if (!window.confirm("Delete this message?")) return;
        removeButton.disabled = true;
        try {
          await deleteChatMessage(state.activeChat, message.id);
          showToast("Message deleted.");
        } catch (error) {
          showToast(friendlyAuthError(error));
          removeButton.disabled = false;
        }
      });
      actions.appendChild(removeButton);
    }
    if (actions.childElementCount) content.appendChild(actions);
  }

  row.append(avatar, content);
  return row;
}

function renderMessages() {
  const queryText = $("chatSearchInput").value.trim().toLowerCase();
  const filtered = state.messages.filter(msg => !queryText || String(msg.text || "").toLowerCase().includes(queryText));

  $("messagesList").replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const message of filtered) {
    fragment.appendChild(createMessageRow(message));
  }
  $("messagesList").appendChild(fragment);
  $("emptyMessages").classList.toggle("hidden", state.messages.length > 0 || Boolean(queryText));
  $("messagesArea").scrollTop = $("messagesArea").scrollHeight;
}

async function sendCurrentMessage(event) {
  event?.preventDefault();
  const text = $("messageInput").value.trim();
  if (!text) return;
  if (!state.user || !state.profile) return showToast("Sign in before sending messages.");

  $("sendBtn").disabled = true;
  try {
    await sendChatMessage(state.activeChat, text, state.profile);
    $("messageInput").value = "";
    $("messageInput").focus();
  } catch (error) {
    showToast(friendlyAuthError(error));
  } finally {
    $("sendBtn").disabled = false;
  }
}

function panelHeading(title, description) {
  const heading = el("div", "panel-heading");
  const copy = el("div");
  copy.append(el("h2", "", title), el("p", "", description));
  heading.appendChild(copy);
  return heading;
}

function renderDiscoverPanel() {
  const panel = $("contentPanel");
  panel.replaceChildren(panelHeading("Find people", "Search by Emarni ID or display name to connect."));

  const searchWrap = el("div", "panel-search");
  const input = el("input");
  input.type = "search";
  input.placeholder = "Search name or Emarni ID (e.g. EM12345678)";
  searchWrap.appendChild(input);
  panel.appendChild(searchWrap);

  const grid = el("div", "panel-grid");
  panel.appendChild(grid);

  const draw = () => {
    grid.replaceChildren();
    const term = input.value.trim().toLowerCase();
    const candidates = Object.values(state.directory)
      .filter(user => user?.uid && user.uid !== state.user?.uid)
      .filter(user => !term || `${user.displayName || ""} ${user.emarniId || ""}`.toLowerCase().includes(term));

    if (!candidates.length) {
      grid.appendChild(el("div", "empty-panel", "No users found."));
      return;
    }

    candidates.forEach(user => {
      const card = el("article", "person-card");
      const avatar = el("div", "avatar avatar-large");
      renderAvatar(avatar, user.displayName, user.photoURL, "avatar avatar-large");

      const details = el("div", "person-info");
      details.append(el("strong", "", user.displayName || "Emarni user"), el("span", "", `@${user.emarniId || ""}`));

      const friend = state.friendships[user.uid]?.status === "accepted";
      const requestPending = Boolean(state.requests[user.uid]?.status === "pending");

      const action = el("button", `small-btn${friend ? " neutral" : ""}`, friend ? "Friends" : requestPending ? "Requested" : "Add friend");
      action.disabled = friend || requestPending;

      if (!action.disabled) {
        action.addEventListener("click", async () => {
          action.disabled = true;
          try {
            await sendFriendRequest(user.uid, state.profile);
            showToast("Friend request sent.");
            action.textContent = "Request sent";
          } catch (error) {
            showToast(friendlyAuthError(error));
            action.disabled = false;
          }
        });
      }

      card.append(avatar, details, action);
      grid.appendChild(card);
    });
  };

  input.addEventListener("input", draw);
  draw();
}

function renderRequestsPanel() {
  const panel = $("contentPanel");
  panel.replaceChildren(panelHeading("Friend requests", "Accept requests to enable private messaging."));

  const grid = el("div", "panel-grid");
  panel.appendChild(grid);

  const pending = Object.entries(state.requests).filter(([, req]) => req?.status === "pending");
  if (!pending.length) {
    grid.appendChild(el("div", "empty-panel", "No pending friend requests."));
    return;
  }

  pending.forEach(([requesterUid, request]) => {
    const user = publicProfileByUid(requesterUid) || { displayName: request.fromName, emarniId: request.fromEmarniId };
    const card = el("article", "request-card");
    const avatar = el("div", "avatar avatar-large");
    renderAvatar(avatar, user.displayName, user.photoURL, "avatar avatar-large");

    const details = el("div", "person-info");
    details.append(el("strong", "", user.displayName), el("span", "", `@${user.emarniId || ""}`));

    const actions = el("div", "card-action-stack");
    const accept = el("button", "small-btn", "Accept");
    const decline = el("button", "small-btn neutral", "Decline");

    accept.addEventListener("click", async () => {
      try {
        await respondFriendRequest(requesterUid, true);
        showToast("Friend request accepted!");
        renderRequestsPanel();
      } catch (error) {
        showToast(friendlyAuthError(error));
      }
    });

    decline.addEventListener("click", async () => {
      try {
        await respondFriendRequest(requesterUid, false);
        showToast("Declined.");
        renderRequestsPanel();
      } catch (error) {
        showToast(friendlyAuthError(error));
      }
    });

    actions.append(accept, decline);
    card.append(avatar, details, actions);
    grid.appendChild(card);
  });
}

function renderFriendsPanel() {
  const panel = $("contentPanel");
  panel.replaceChildren(panelHeading("Your friends", "Accepted friends can chat privately."));

  const grid = el("div", "panel-grid");
  panel.appendChild(grid);

  const friends = sortedFriends();
  if (!friends.length) {
    grid.appendChild(el("div", "empty-panel", "No friends yet. Find people to add."));
    return;
  }

  friends.forEach(({ uid, profile }) => {
    const card = el("article", "friend-card");
    const avatar = el("div", "avatar avatar-large");
    renderAvatar(avatar, profile.displayName, profile.photoURL, "avatar avatar-large");

    const details = el("div", "person-info");
    details.append(el("strong", "", profile.displayName), el("span", "", `@${profile.emarniId}`));

    const action = el("button", "small-btn", "Message");
    action.addEventListener("click", async () => {
      try {
        const roomId = await openPrivateChat(uid);
        activateChat({ type: "private", id: roomId, title: profile.displayName, subtitle: "Private conversation." });
      } catch (error) {
        showToast(friendlyAuthError(error));
      }
    });

    card.append(avatar, details, action);
    grid.appendChild(card);
  });
}

function renderGroupList() {
  const target = $("groupsList");
  target.replaceChildren();
  if (!state.groups.length) {
    target.appendChild(el("p", "subtle-empty", "Your groups will appear here."));
    return;
  }

  state.groups.forEach(group => {
    const button = el("button", `group-nav-item${state.activeChat.id === group.id ? " active" : ""}`);
    button.append(el("span", "group-type-mark", group.type === "business" ? "B" : "G"), el("span", "group-nav-name", group.name));
    button.addEventListener("click", () => {
      activateChat({ type: "group", id: group.id, title: group.name, subtitle: group.description || "Group chat" });
    });
    target.appendChild(button);
  });
}

// অ্যাডমিন প্যানেল রেন্ডারিং ফাংশন
function renderAdminUsers() {
  const target = $("adminUsersList");
  target.replaceChildren();
  const term = $("adminUserSearch").value.trim().toLowerCase();

  const users = Object.values(state.directory)
    .filter(u => !term || `${u.displayName || ""} ${u.emarniId || ""} ${u.uid}`.toLowerCase().includes(term));

  if (!users.length) {
    target.appendChild(el("p", "subtle-empty", "No users found."));
    return;
  }

  users.forEach(user => {
    const row = el("div", "admin-user-row");
    const info = el("div", "person-info");
    info.append(
      el("strong", "", user.displayName || "User"),
      el("span", "", `ID: @${user.emarniId} | UID: ${user.uid}`)
    );

    const isBanned = Boolean(state.banned[user.uid]);
    const action = el("button", `small-btn ${isBanned ? "neutral" : "danger"}`, isBanned ? "Unban" : "Ban");
    action.addEventListener("click", async () => {
      try {
        await setUserBan(user.uid, !isBanned);
        showToast(isBanned ? "User unbanned." : "User banned.");
      } catch (error) {
        showToast(friendlyAuthError(error));
      }
    });

    row.append(info, action);
    target.appendChild(row);
  });
}

// ইভেন্ট লিসেনার্স
$("authSwitch").addEventListener("click", () => setAuthMode(state.authMode === "signin" ? "signup" : "signin"));

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const displayName = $("signupName").value.trim();

  try {
    if (state.authMode === "signup") {
      await registerAccount({ email, password, displayName });
      showToast("Account created successfully!");
    } else {
      await signInAccount(email, password);
      showToast("Signed in successfully.");
    }
  } catch (error) {
    showToast(friendlyAuthError(error));
  }
});

$("signOutBtn").addEventListener("click", () => signOutAccount());

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => changeView(btn.dataset.view));
});

$("menuBtn").addEventListener("click", () => $("sidebar").classList.add("open"));
$("closeSidebar").addEventListener("click", () => $("sidebar").classList.remove("open"));

$("composerForm").addEventListener("submit", sendCurrentMessage);
$("messageInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage(e);
  }
});

$("editProfileBtn").addEventListener("click", () => {
  $("profileNameInput").value = state.profile?.displayName || "";
  $("profileBioInput").value = state.profile?.bio || "";
  $("profileDialog").showModal();
});

$("profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    state.profile = await saveUserProfile({
      displayName: $("profileNameInput").value.trim(),
      bio: $("profileBioInput").value.trim()
    });
    updateProfileUI();
    $("profileDialog").close();
    showToast("Profile updated.");
  } catch (error) {
    showToast(friendlyAuthError(error));
  }
});

$("aboutBtn").addEventListener("click", () => $("aboutDialog").showModal());
$("aboutHeaderBtn").addEventListener("click", () => $("aboutDialog").showModal());

// অ্যাডমিন প্যানেল ওপেন ও সিক্রেট লগইন হ্যান্ডলার
$("adminOpenBtn").addEventListener("click", () => {
  $("adminDialog").showModal();
  if (state.adminUnlocked) {
    $("adminLoginSection").classList.add("hidden");
    $("adminDashboardSection").classList.remove("hidden");
    renderAdminUsers();
  } else {
    $("adminLoginSection").classList.remove("hidden");
    $("adminDashboardSection").classList.add("hidden");
  }
});

$("adminLoginForm").addEventListener("submit", e => {
  e.preventDefault();
  const u = $("adminSecretUser").value.trim();
  const p = $("adminSecretPass").value.trim();

  // আপনার দেওয়া কাস্টম অ্যাডমিন ইউজারনেম ও পাসওয়ার্ড
  if (u === "admin" && p === "EmarniAdmin2026!") {
    state.adminUnlocked = true;
    showToast("Admin Panel Unlocked Successfully!");
    $("adminLoginSection").classList.add("hidden");
    $("adminDashboardSection").classList.remove("hidden");
    renderAdminUsers();
  } else {
    showToast("Incorrect Admin Credentials!");
  }
});

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => $(btn.dataset.close).close());
});

// অ্যাপ বুটস্টপ ও স্প্ল্যাশ স্ক্রিন রিমুভ
watchAuth(async user => {
  await sleep(800);
  $("splashScreen")?.classList.add("fade-out");

  if (user) {
    state.user = user;
    try {
      state.profile = await ensureUserProfile(user);
      updateProfileUI();
      $("authScreen").classList.add("hidden");
      $("appLayout").classList.remove("hidden");

      watchUserDirectory(data => { state.directory = data; renderAdminUsers(); });
      watchFriendships(user.uid, data => { state.friendships = data; });
      watchIncomingRequests(user.uid, data => { state.requests = data; updateRequestCount(); });
      watchMyGroups(user.uid, groups => { state.groups = groups; renderGroupList(); });

      activateChat({ type: "global", id: "global", title: "Global Lounge", subtitle: "Join the conversation with the Emarni community." });
    } catch (err) {
      console.error(err);
      signOutAccount();
    }
  } else {
    $("appLayout").classList.add("hidden");
    $("authScreen").classList.remove("hidden");
  }
});

setAuthMode("signin");
