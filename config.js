/* Configuration d'Architmind CI.
   Ces valeurs Firebase sont publiques par nature : la sécurité des données
   repose sur les règles Firestore (fichier firestore.rules), pas sur ces clés.
   Ne mettez JAMAIS ici de clé secrète (CinetPay, Brevo, compte de service Firebase). */
window.ARCHITMIND_CONFIG = {
  firebase: {
    apiKey: "AIzaSyDSLPtkkKHg5h6SQToNQMDhBGJSaBBkATI",
    authDomain: "architmind-74294.firebaseapp.com",
    projectId: "architmind-74294",
    storageBucket: "architmind-74294.firebasestorage.app",
    messagingSenderId: "116282524581",
    appId: "1:116282524581:web:86cb4bc35924bdebbbde4c"
  },

  // Adresse du serveur de paiement (Vercel), sans barre finale.
  // Exemple : "https://architmind-paiement.vercel.app"
  // Tant qu'elle est vide, les boutons des Tarifs annoncent « paiement bientôt disponible ».
  paiementUrl: ""
};
