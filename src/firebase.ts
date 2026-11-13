import { initializeApp } from 'firebase/app';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';

// Use import.meta.glob so Vite never fails the build on Vercel/GitHub if firebase-applet-config.json is excluded on export
const appletConfigModules = import.meta.glob('../firebase-applet-config.json', {
  eager: true,
  import: 'default'
}) as Record<string, Record<string, string>>;

const loadedAppletConfig = appletConfigModules['../firebase-applet-config.json'];

const firebaseConfig = {
  projectId:
    loadedAppletConfig?.projectId ||
    import.meta.env.VITE_FIREBASE_PROJECT_ID ||
    'gen-lang-client-0437386035',
  appId:
    loadedAppletConfig?.appId ||
    import.meta.env.VITE_FIREBASE_APP_ID ||
    '1:532490339410:web:9d7bba10343207d6e88b8b',
  apiKey:
    loadedAppletConfig?.apiKey ||
    import.meta.env.VITE_FIREBASE_API_KEY ||
    'AIzaSyAC0O-NxbyO7tIvjL6O-6h6fMPIOEssTkk',
  authDomain:
    loadedAppletConfig?.authDomain ||
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
    'gen-lang-client-0437386035.firebaseapp.com',
  firestoreDatabaseId:
    loadedAppletConfig?.firestoreDatabaseId ||
    import.meta.env.VITE_FIREBASE_DATABASE_ID ||
    'ai-studio-meridianportfoli-7af0c6bc-62c2-487e-bbed-95c4aefdba2d',
  storageBucket:
    loadedAppletConfig?.storageBucket ||
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ||
    'gen-lang-client-0437386035.firebasestorage.app',
  messagingSenderId:
    loadedAppletConfig?.messagingSenderId ||
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ||
    '532490339410'
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Single-user personal workspace ID shared automatically across all devices
export const PERSONAL_PORTFOLIO_ID = 'personal-portfolio';

// Validate connection to Firestore on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  workspaceId: string;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): void {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    workspaceId: PERSONAL_PORTFOLIO_ID,
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
}
