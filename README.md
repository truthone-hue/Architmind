# Architmind CI

Du terrain nu à la maison en 3D. Architmind CI produit des plans cotés et meublés, adaptés à la ville et au côté de la rue. Il donne aussi le coût des travaux en FCFA, les matériaux conseillés selon le climat et une maquette 3D extérieure et intérieure. Il couvre la Côte d'Ivoire et l'Afrique de l'Ouest, de la villa plain-pied à l'immeuble R+10.

Fait par **Hunter Agency**.

## Utiliser l'application

Adresse : **https://truthone-hue.github.io/Architmind/**

Architmind s'installe comme une application, sans passer par un magasin d'applications :

| Appareil | Installation |
|---|---|
| Android (Chrome) | Bouton « Installer l'application » sur la page d'accueil, ou menu ⋮ puis « Installer l'application » |
| iPhone et iPad (Safari) | Bouton Partager, puis « Sur l'écran d'accueil » |
| Windows, macOS, Linux (Chrome ou Edge) | Bouton « Installer l'application », ou icône d'installation dans la barre d'adresse |
| macOS (Safari 17 et plus) | Menu Fichier, puis « Ajouter au Dock » |

**Hors ligne.** Après une première visite avec internet, l'application fonctionne sans connexion : création de plans, propositions, maquette 3D et projets enregistrés. Les projets enregistrés hors ligne rejoignent le compte dès le retour de la connexion. Il faut internet pour l'inscription, le paiement et le changement de mot de passe.

## Fonctionnement

- **Comptes.** Firebase Authentication, avec adresse e-mail et mot de passe. Mot de passe oublié : lien de réinitialisation par e-mail.
- **Données.** Cloud Firestore, avec une copie sur l'appareil pour le hors ligne :
  - `utilisateurs/{uid}` : nom, e-mail, profil, ville, compteur de plans du jour, abonnement ;
  - `utilisateurs/{uid}/plans` : projets enregistrés ;
  - `utilisateurs/{uid}/notifications` : paiement reçu, renouvellement, échéance.
- **Sécurité.** Les règles de `firestore.rules` limitent chaque compte à ses propres données. L'abonnement et les notifications ne peuvent être écrits que par le serveur de paiement.
- **Paiement.** CinetPay (Mobile Money et carte bancaire), par un serveur de paiement séparé. Tant que `paiementUrl` est vide dans `config.js`, les Tarifs annoncent « paiement bientôt disponible ».

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | L'application complète : interface, moteur de plans, 3D |
| `config.js` | Configuration Firebase (publique) et adresse du serveur de paiement |
| `sw.js` | Fonctionnement hors ligne (service worker) |
| `manifest.webmanifest`, `icons/` | Installation sur téléphone et ordinateur |
| `firestore.rules` | Règles de sécurité à publier dans la console Firebase |

## Mise en service

1. **Firebase, Authentication.** Activez le fournisseur « Adresse e-mail/Mot de passe ». Dans *Paramètres, Domaines autorisés*, ajoutez `truthone-hue.github.io`. Dans *Modèles*, choisissez le français pour les e-mails.
2. **Firebase, Firestore.** Dans l'onglet *Règles*, collez le contenu de `firestore.rules`, puis cliquez sur *Publier*.
3. **GitHub Pages.** Dans *Settings, Pages*, choisissez *Deploy from a branch*, puis `main` et `/ (root)`.
4. **Mise à jour.** Après chaque modification, augmentez `VERSION` dans `sw.js` : les appareils des utilisateurs téléchargeront alors la nouvelle version.

## Tester sur son ordinateur

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

Ne mettez jamais de clé secrète dans ce dépôt (CinetPay, Brevo, compte de service Firebase). Elles se placent dans les variables d'environnement du serveur de paiement.
