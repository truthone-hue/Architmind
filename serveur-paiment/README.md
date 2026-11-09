# Architmind CI : serveur de paiement

Petit serveur hébergé gratuitement sur **Cloudflare Workers**. Il encaisse les offres **Moyen** (30 000 FCFA) et **Max** (60 000 FCFA) d'Architmind CI avec **Paystack**, par Mobile Money ou carte bancaire.

## Ce qu'il fait

| Étape | Rôle du serveur |
|---|---|
| Le client choisit une offre dans les Tarifs | Il vérifie la connexion Firebase du client, puis ouvre la page de paiement Paystack. |
| Paystack confirme le paiement | Il contrôle la signature, le montant et la devise. Il active ensuite l'offre pour 30 jours, ou ajoute 30 jours si le client renouvelle avant l'échéance. |
| Juste après le paiement | Il envoie une notification sur le site et un reçu par e-mail. |
| Chaque jour à 8 h | Il envoie les rappels d'échéance 7, 3 et 1 jour avant la fin, puis à l'expiration : notification sur le site et e-mail. |

## Mise en service

### 1. Déployer sur Cloudflare

1. Dans Cloudflare, ouvrez **Workers & Pages**, puis **Créer**, puis **Importer un dépôt** (Import a repository).
2. Choisissez le dépôt GitHub `Architmind`. Dans les paramètres de build, indiquez le **répertoire racine** (Root directory) `serveur-paiment`, puis cliquez sur **Déployer**. Cloudflare lit `wrangler.jsonc` et met en ligne le serveur.
3. Notez l'adresse obtenue, par exemple `https://architmind-paiement.votre-compte.workers.dev`.

### 2. Saisir les secrets

Dans le Worker, ouvrez **Paramètres**, puis **Variables et secrets**. Ajoutez ces valeurs en choisissant le type **Secret** :

| Nom | Où la trouver |
|---|---|
| `PAYSTACK_SECRET` | Paystack, **Settings**, puis **API Keys & Webhooks** : la *Secret Key* (`sk_test_…` en test, `sk_live_…` en réel) |
| `FIREBASE_SERVICE_ACCOUNT` | Console Firebase, **Paramètres du projet**, puis **Comptes de service** : **Générer une nouvelle clé privée**. Collez tout le contenu du fichier JSON téléchargé. |
| `BREVO_API_KEY` | Brevo, **SMTP & API**, puis **Clés API** |

Ajoutez aussi une variable de type **Texte** :

| Nom | Valeur |
|---|---|
| `MAIL_EXPEDITEUR` | L'adresse d'envoi des e-mails, validée dans Brevo (**Expéditeurs**) |

Ne mettez jamais ces clés dans le code, dans GitHub ou dans une conversation.

### 3. Relier Paystack

Dans Paystack, ouvrez **Settings**, puis **API Keys & Webhooks**. Dans **Webhook URL**, collez l'adresse du serveur suivie de `/api/paiement/webhook`.

### 4. Relier le site

Dans `config.js` du site Architmind, renseignez `paiementUrl` avec l'adresse du serveur, sans barre finale.

### 5. Passer en paiements réels

Une fois votre compte validé par Paystack, faites deux changements :
- remplacez `PAYSTACK_SECRET` par la clé `sk_live_…` ;
- collez l'adresse du webhook dans la partie **Live** de Paystack.

## Tester

```bash
npm test
```

Les tests simulent Paystack, Firebase, Google et Brevo. Ils couvrent :
- la création du paiement ;
- le refus d'une signature fausse ;
- l'activation de l'offre ;
- les doublons ;
- le renouvellement ;
- un montant trafiqué ;
- les rappels.

## Adresses

| Adresse | Rôle |
|---|---|
| `GET /` | Santé du serveur, avec le mode test ou réel |
| `POST /api/paiement/creer` | Démarre un paiement (client connecté) |
| `POST /api/paiement/verifier` | Vérifie un paiement au retour sur le site |
| `POST /api/paiement/webhook` | Confirmation envoyée par Paystack |

Fait par Hunter Agency.
