import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  getDocs,
  arrayUnion,
  arrayRemove,
  serverTimestamp
} from 'firebase/firestore';
import { firebaseConfig } from './config.js';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ── AUTH ──
export async function registerUser(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  await setDoc(doc(db, 'users', cred.user.uid), {
    uid: cred.user.uid,
    displayName,
    email,
    brands: [],
    availability: 'empty',
    stock: 0,
    location: null,
    lastSeen: serverTimestamp(),
    friends: [],
    createdAt: serverTimestamp()
  });
  return cred.user;
}

export async function loginUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logoutUser() {
  await signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ── USER PROFILE ──
export async function getUser(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

export async function updateUserProfile(uid, data) {
  await updateDoc(doc(db, 'users', uid), {
    ...data,
    lastSeen: serverTimestamp()
  });
}

// ── LIVE LOCATION ──
export async function updateLocation(uid, lat, lng) {
  await updateDoc(doc(db, 'users', uid), {
    location: { lat, lng },
    lastSeen: serverTimestamp()
  });
}

// ── FRIENDS ──
export async function searchUserByEmail(email) {
  const q = query(collection(db, 'users'), where('email', '==', email.toLowerCase().trim()));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

export async function addFriend(myUid, friendUid) {
  await updateDoc(doc(db, 'users', myUid), {
    friends: arrayUnion(friendUid)
  });
}

export async function removeFriend(myUid, friendUid) {
  await updateDoc(doc(db, 'users', myUid), {
    friends: arrayRemove(friendUid)
  });
}

// ── REAL-TIME LISTENERS ──
export function listenToUser(uid, callback) {
  return onSnapshot(doc(db, 'users', uid), snap => {
    if (snap.exists()) callback(snap.data());
  });
}

export function listenToFriend(uid, callback) {
  return onSnapshot(doc(db, 'users', uid), snap => {
    if (snap.exists()) callback(snap.data());
  });
}

// ── PING ──
export async function pingUser(fromUid, fromName, toUid) {
  const pingRef = doc(collection(db, 'pings'));
  await setDoc(pingRef, {
    from: fromUid,
    fromName,
    to: toUid,
    timestamp: serverTimestamp(),
    read: false
  });
}

export function listenToPings(uid, callback) {
  const q = query(
    collection(db, 'pings'),
    where('to', '==', uid),
    where('read', '==', false)
  );
  return onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        callback(change.doc.data());
        updateDoc(change.doc.ref, { read: true });
      }
    });
  });
}
