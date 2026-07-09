
/* ---- configuration publique ----
   DONATION_URL : remplacez par VOTRE lien (Ko-fi, Liberapay, PayPal.me…).
   Laissez une chaîne vide "" pour masquer le bouton de don. */
const DONATION_URL = "https://ko-fi.com/wyyne/donate";

/* Serveurs ICE pour le chat vocal (WebRTC pair-à-pair).
   STUN Google = gratuit et fiable pour trouver le chemin direct.
   Le relais TURN ci-dessous (Open Relay / Metered) est un service gratuit
   "best effort" utilisé seulement quand la connexion directe échoue
   (réseaux très fermés). Vous pouvez le remplacer par le vôtre. */
const RTC_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443"],
      username: "openrelayproject", credential: "openrelayproject" },
  ],
};

/* ---- shim de stockage pour usage local ---- */
window.storage = {
  async get(key, shared) {
    if (!shared) { const v = localStorage.getItem("mtg_" + key); if (v === null) throw new Error("not found"); return { key, value: v, shared: false }; }
    const r = await fetch("/kv/" + encodeURIComponent(key)); if (!r.ok) throw new Error("not found");
    return { key, value: await r.text(), shared: true };
  },
  async set(key, value, shared) {
    if (!shared) { localStorage.setItem("mtg_" + key, value); return { key, value, shared: false }; }
    await fetch("/kv/" + encodeURIComponent(key), { method: "PUT", body: value });
    return { key, value, shared: true };
  },
  async delete(key, shared) {
    if (!shared) { localStorage.removeItem("mtg_" + key); return { key, deleted: true, shared: false }; }
    await fetch("/kv/" + encodeURIComponent(key), { method: "DELETE" });
    return { key, deleted: true, shared: true };
  },
};
const { useState, useEffect, useLayoutEffect, useRef, useMemo } = React;

/* ============================================================
   TABLE COMMANDER — simulateur de jeu manuel pour 2 à 6 joueurs
   - Les règles ne sont PAS automatisées : vous résolvez tout.
   - Plateau plein écran, sans défilement : moitié adverse en
     haut (miroir), la vôtre en bas, main en éventail.
   ============================================================ */

/* ---------- utilitaires ---------- */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const shuffleArr = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const makeCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
const MANA = ["#f2ecd8", "#3f7fb5", "#8b7f9e", "#c14f37", "#4f9e6b"];
const GROUP_COLORS = ["#d3ab4e", "#3f7fb5", "#4f9e6b", "#c14f37", "#a67bd1", "#d1793f", "#4fb5ad"];

const S = typeof window !== "undefined" ? window.storage : null;
async function sget(k, shared = false) { if (!S) return null; try { const r = await S.get(k, shared); return r && r.value ? JSON.parse(r.value) : null; } catch (e) { return null; } }
async function sset(k, v, shared = false) { if (!S) return false; try { await S.set(k, JSON.stringify(v), shared); return true; } catch (e) { console.error("storage:", e); return false; } }
async function sdel(k, shared = false) { if (!S) return; try { await S.delete(k, shared); } catch (e) {} }

/* hauteur de fenêtre réactive : sert à dimensionner cartes et rangées */
function useVH() {
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => {
    const f = () => setVh(window.innerHeight);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return vh;
}
/* largeur d'un élément (pour compresser les rangées pleines) */
function useWidth(ref, ready = true) {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ready || !ref.current || typeof ResizeObserver === "undefined") return;
    setW(ref.current.getBoundingClientRect().width);
    const ro = new ResizeObserver((es) => setW(es[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ready]);
  return w;
}

/* ---------- import de deck ---------- */
function parseDecklist(text) {
  const lines = text.split(/\r?\n/); const out = [];
  for (let raw of lines) {
    let l = raw.trim();
    if (!l || /^(\/\/|#|sideboard|deck|commander|companion)/i.test(l)) continue;
    const m = l.match(/^(\d+)\s*[xX]?\s+(.+)$/);
    let count = 1, name = l;
    if (m) { count = parseInt(m[1], 10); name = m[2]; }
    name = name.replace(/\s+\([A-Za-z0-9]{2,6}\)\s*[\w-★]*\s*$/,"").replace(/\s*\*F\*\s*$/,"").trim();
    if (name) out.push({ count: Math.max(1, count), name });
  }
  return out;
}

/* nom affiché : tient compte de la face visible pour les cartes recto-verso */
const dn = (c) => (c && (c.flipped ? (c.bfn || c.bname || c.fn || c.name) : (c.fn || c.name))) || "";
/* images de la face actuellement visible (petite et grande) */
const fimg = (c) => (c && c.flipped && c.bimg) ? c.bimg : (c && c.img) || null;
const fimgN = (c) => (c && c.flipped && (c.bimgN || c.bimg)) ? (c.bimgN || c.bimg) : (c && (c.imgN || c.img)) || null;
/* normalise pour comparer sans tenir compte de la casse ni des accents
   (utile pour filtrer/chercher indifféremment en français ou en anglais) */
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/* ================= internationalisation =================
   UI_LANG est la langue de l'interface ("fr" ou "en").
   t(s) : s est la chaîne française ; en anglais on cherche sa
   traduction dans TR (sinon on garde le français en secours).
   Les termes connus du jeu qui marchent dans les deux langues
   (Mulligan, noms de jetons, d6/d20…) ne sont pas traduits. */
let UI_LANG = "fr";
const t = (str) => (UI_LANG === "en" ? (TR[str] !== undefined ? TR[str] : str) : str);
const TR = {
  "marqueur": "counter",
  "marqueurs": "counters",
  "Copier le code": "Copy the room code",
  "copié !": "copied!",
  "Aimant : aligne les cartes posées sur les bandes": "Magnet: snaps placed cards to the bands",
  "🫳 Prendre le contrôle": "🫳 Take control",
  "🫳 Prendre en main": "🫳 Take to my hand",
  "↩ Rendre au propriétaire": "↩ Return to owner",
  "Prendre cette carte (effet de vol)": "Take this card (steal effect)",
  "Bibliothèque adverse : actions (effets qui le demandent)": "Opponent's library: actions (for effects that ask it)",
  "Voler la carte du dessus (→ ma main)": "Steal the top card (→ my hand)",
  "Voler la carte du dessus (→ mon champ)": "Steal the top card (→ my battlefield)",
  "Exiler la carte du dessus": "Exile the top card",
  "Meuler la carte du dessus": "Mill the top card",
  "Regarder la carte du dessus": "Look at the top card",
  "Fouiller toute la bibliothèque": "Search the whole library",
  "la carte du dessus de": "the top card of",
  "Dessus de": "Top of",
  "Voir la bibliothèque adverse (effets qui le demandent)": "View opponent's library (for effects that ask it)",
  "prend le contrôle de": "takes control of",
  "prend": "takes",
  "de": "of",
  "perd le contrôle de": "loses control of",
  "récupère": "gets back",
  "rendue par": "returned by",
  "rend": "returns",
  "pioche une carte": "draws a card",
  "pioche": "draws",
  "carte": "card",
  "essaie de piocher… bibliothèque vide !": "tries to draw… empty library!",
  "essaie de meuler… bibliothèque vide !": "tries to mill… empty library!",
  "mélange sa bibliothèque": "shuffles their library",
  "dégage tout": "untaps everything",
  "fait un mulligan : main mélangée dans la bibliothèque, re-pioche": "mulligans: hand shuffled into library, redraws",
  "meule": "mills",
  "ajoute un marqueur": "adds a counter",
  "retire un marqueur": "removes a counter",
  "sur": "on",
  "de la carte": "from",
  "liée": "linked",
  "liées": "linked",
  "et": "and",
  "carte liée": "linked card",
  "cartes liées": "linked cards",
  "dégage": "untaps",
  "engage": "taps",
  "une carte": "a card",
  "crée une copie-jeton de": "creates a token copy of",
  "choisit une illustration": "picks an artwork",
  "pour": "for",
  "rétablit l'illustration de": "restores the artwork of",
  "crée un jeton": "creates a token",
  "crée le groupe": "creates the group",
  "lie": "links",
  "délie": "unlinks",
  "au groupe": "to the group",
  "du groupe": "from the group",
  "supprime le groupe": "deletes the group",
  "supprime le jeton": "deletes the token",
  "lance une pièce :": "flips a coin:",
  "PILE": "HEADS",
  "FACE": "TAILS",
  "lance un": "rolls a",
  "termine son tour": "ends their turn",
  "rejoint le vocal 🎙": "joins voice chat 🎙",
  "quitte le vocal": "leaves voice chat",
  "regarde les": "looks at the top",
  "cartes du dessus": "cards of their library",
  "cherche dans sa bibliothèque": "searches their library",
  "rejoint la table et pioche 7 cartes": "joins the table and draws 7 cards",
  "attache": "attaches",
  "à": "to",
  "détache": "detaches",
  "joue": "plays",
  "attachée à": "attached to",
  "joue une carte face cachée": "plays a card face down",
  "lance son commandant": "casts their commander",
  "se défausse de": "discards",
  "met": "puts",
  "au cimetière": "into the graveyard",
  "exile": "exiles",
  "renvoie": "returns",
  "en zone de commandement": "to the command zone",
  "reprend": "takes back",
  "en main": "to hand",
  "remet une carte": "puts a card",
  "sous": "under",
  "sous la bibliothèque": "under the library",
  "sur la bibliothèque": "on top of the library",
  "sur le champ de bataille": "onto the battlefield",
  "une carte face cachée": "a face-down card",
  "Piocher": "Draw",
  "Déployer les équipements": "Deploy attachments",
  "Ranger les équipements": "Tidy attachments",
  "Dégager tout": "Untap all",
  "Mélanger": "Shuffle",
  "Regarder X": "Look at X",
  "Meuler X": "Mill X",
  "Chercher": "Search",
  "+ Créer un jeton": "+ Create a token",
  "⛓ Créer un groupe": "⛓ Create a group",
  "Pièce": "Coin",
  "Fin du tour": "End turn",
  "Tour adverse": "Opponent's turn",
  "Journal": "Log",
  "Biblio": "Library",
  "Main": "Hand",
  "Cim.": "GY",
  "Exil": "Exile",
  "Cmdt": "Cmdr",
  "★ Cmdt": "★ Cmdr",
  "cmdt": "cmdr",
  "en attente…": "waiting…",
  "Adversaire suivant": "Next opponent",
  "Adversaire précédent": "Previous opponent",
  "Clic : piocher · Déposez une carte : dessus de la bibliothèque": "Click: draw · Drop a card: top of library",
  "Cliquez pour lancer votre commandant": "Click to cast your commander",
  "Dégâts de commandant reçus (21 = défaite)": "Commander damage taken (21 = loss)",
  "Joueurs avec plus de 0 point de vie": "Players above 0 life",
  "Joueurs connectés au vocal avec vous": "Players in voice chat with you",
  "Rejoindre le chat vocal (pair-à-pair)": "Join voice chat (peer-to-peer)",
  "Soutenir le développement": "Support development",
  "? Aide": "? Help",
  "Confirmer le reset ?": "Confirm reset?",
  "Quitter": "Leave",
  "Salon": "Room",
  "🎙 Vocal": "🎙 Voice",
  "✕ Vocal": "✕ Voice",
  "🔇 Muet": "🔇 Muted",
  "🎙 Micro on": "🎙 Mic on",
  "connecté": "connected",
  "connectés": "connected",
  " · connexion…": " · connecting…",
  "❤ Don": "❤ Donate",
  "❤ Soutenir le projet": "❤ Support the project",
  "Cliquez sur la carte cible pour attacher": "Click the target card to attach",
  "Cliquez sur des cartes pour les lier / délier du groupe": "Click cards to link / unlink them to the group",
  "Annuler (Échap)": "Cancel (Esc)",
  "Terminer (Échap)": "Done (Esc)",
  "Tour": "Turn",
  "à vous de jouer": "your turn",
  "tour de": "turn of",
  "l'adversaire": "the opponent",
  "partagez le code": "share the code",
  "En attente d'adversaires — code": "Waiting for opponents — code",
  "Mulligan — re-piocher combien ?": "Mulligan — redraw how many?",
  "Regarder le dessus": "Look at the top",
  "Meuler — combien de cartes au cimetière ?": "Mill — how many cards to the graveyard?",
  "Nom du marqueur": "Counter name",
  "ex. poison, provoc, indestructible…": "e.g. poison, stun, shield…",
  "Nom du groupe": "Group name",
  "ex. équipe d'attaque, enchantés…": "e.g. attack squad, enchanted…",
  "Nombre de cartes": "Number of cards",
  "Annuler": "Cancel",
  "▶ Jouer": "▶ Play",
  "🙈 Jouer face cachée": "🙈 Play face down",
  "🗑 Se défausser": "🗑 Discard",
  "⭐ Lancer le commandant": "⭐ Cast the commander",
  "↺ Dégager": "↺ Untap",
  "⤵ Engager": "⤵ Tap",
  "✂ Détacher": "✂ Detach",
  "🔗 Attacher à… (cliquez la cible)": "🔗 Attach to… (click the target)",
  "Marqueurs & état": "Counters & state",
  "➕ Ajouter un marqueur": "➕ Add a counter",
  "➖ Retirer un marqueur": "➖ Remove a counter",
  "🏷 Marqueur nommé…": "🏷 Named counter…",
  "👁 Face visible": "👁 Face up",
  "⟳ Transformer": "⟳ Transform",
  "Deck importé avant la prise en charge du recto-verso ? Recliquez sur « Importer les cartes » pour récupérer les faces arrière.": "Deck imported before double-faced support? Click “Import cards” again to fetch the back faces.",
  "Transformer (recto-verso)": "Transform (double-faced)",
  "transforme": "transforms",
  "🙈 Face cachée": "🙈 Face down",
  "🪙 Copie-jeton": "🪙 Token copy",
  "Déplacer vers la rangée": "Move to row",
  "🏔 Terrains": "🏔 Lands",
  "🐉 Créatures": "🐉 Creatures",
  "✨ Autres": "✨ Others",
  "🎨 Changer l'illustration…": "🎨 Change artwork…",
  "🗑 Supprimer le jeton": "🗑 Delete token",
  "Envoyer vers": "Send to",
  "✋ Main": "✋ Hand",
  "🪦 Cimetière": "🪦 Graveyard",
  "🚫 Exil": "🚫 Exile",
  "⭐ Zone de commandement": "⭐ Command zone",
  "📚 Dessus de la bibliothèque": "📚 Top of library",
  "📚 Dessous de la bibliothèque": "📚 Bottom of library",
  "⛓ Lier / délier des cartes (cliquez-les)": "⛓ Link / unlink cards (click them)",
  "Marqueurs du groupe (appliqués aux cartes liées)": "Group counters (applied to linked cards)",
  "🗑 Supprimer le groupe (délie tout)": "🗑 Delete group (unlinks all)",
  "Groupe": "Group",
  "groupe": "group",
  "Délier de": "Unlink from",
  "Carte face cachée": "Face-down card",
  "Retirer un marqueur": "Remove one counter",
  "Ajouter un marqueur": "Add one counter",
  "Terrains": "Lands",
  "Créatures": "Creatures",
  "Artefacts · Enchantements · Autres": "Artifacts · Enchantments · Others",
  "Créer un jeton": "Create a token",
  "Fermer ✕": "Close ✕",
  "Rechercher un jeton… (noms anglais : Treasure, Soldier, 1/1…)": "Search for a token… (Treasure, Soldier, 1/1…)",
  "Rechercher un jeton (français ou anglais)… ex. Trésor, Soldat, 1/1": "Search a token (French or English)… e.g. Treasure, Soldier, 1/1",
  "Filtrer (nom français ou anglais)…": "Filter (French or English name)…",
  "Effacer": "Clear",
  "Aucune carte ne correspond.": "No card matches.",
  "Sans image :": "No image:",
  "Nom du jeton (ex. Zombie décharné)": "Token name (e.g. Gaunt Zombie)",
  "F/E (ex. 2/2)": "P/T (e.g. 2/2)",
  "Créer": "Create",
  "sans image": "without image",
  "Recherche…": "Searching…",
  "Aucun jeton trouvé (ou réseau indisponible).": "No token found (or network unavailable).",
  "Tapez un nom ou cliquez un raccourci ci-dessus. Chaque clic sur un résultat crée un jeton (cliquez plusieurs fois pour plusieurs exemplaires).": "Type a name or click a shortcut above. Each click on a result creates one token (click several times for copies).",
  "cliquez pour créer": "click to create",
  "la main": "hand",
  "le champ de bataille": "battlefield",
  "le cimetière": "graveyard",
  "l'exil": "exile",
  "la bibliothèque": "library",
  "la zone de commandement": "command zone",
  "Mélanger & fermer": "Shuffle & close",
  "Zone vide.": "Empty zone.",
  "N'oubliez pas de mélanger après une recherche !": "Don't forget to shuffle after searching!",
  "Dessus de la bibliothèque": "Top of library",
  "Terminé ✕": "Done ✕",
  "De gauche (dessus) à droite. Les cartes laissées restent dans cet ordre.": "From left (top) to right. Cards left here keep this order.",
  "Bibliothèque vide.": "Empty library.",
  "Champ": "Field",
  "Dessous": "Bottom",
  "↩ Illustration par défaut": "↩ Default artwork",
  "Appliquer à tous les exemplaires de": "Apply to every copy of",
  "et mémoriser dans le deck": "and remember it in the deck",
  "Recherche des impressions sur Scryfall…": "Searching printings on Scryfall…",
  "Aucune impression trouvée pour cette carte.": "No printings found for this card.",
  "cliquez pour choisir": "click to choose",
  "1 · Joueur & deck": "1 · Player & deck",
  "2 · Rejoindre la table": "2 · Join the table",
  "Votre pseudo": "Your nickname",
  "Sûr ?": "Sure?",
  "cartes": "cards",
  "Aucun deck enregistré — créez-en un ci-dessous. Vos decks sont sauvegardés pour les prochaines parties.": "No saved deck — create one below. Your decks are saved for future games.",
  "+ Importer un deck": "+ Import a deck",
  "Créer un salon": "Create a room",
  "Un code à 6 caractères sera généré : envoyez-le à vos amis (jusqu'à 6 joueurs).": "A 6-character code will be generated: send it to your friends (up to 6 players).",
  "Rejoindre": "Join",
  "Entrez le code reçu de votre ami.": "Enter the code your friend sent you.",
  "→ Choisissez un pseudo et un deck pour continuer.": "→ Pick a nickname and a deck to continue.",
  "⚠ Les salons utilisent le stockage partagé de cette app : toute personne ayant le lien peut voir les parties. Jouez entre amis !": "⚠ Rooms use this app's shared storage: anyone with the code can see the games. Play with friends!",
  "Salon introuvable. Vérifiez le code (et que vous utilisez le même lien d'app que votre ami).": "Room not found. Check the code (and that you're using the same app link as your friend).",
  "Salon complet (6 joueurs max).": "Room full (6 players max).",
  "Simulateur manuel pour 2 à 6 joueurs · vous résolvez les effets vous-mêmes, comme sur une vraie table": "Manual simulator for 2–6 players · you resolve effects yourselves, just like at a real table",
  "Modifier le deck": "Edit deck",
  "Nouveau deck": "New deck",
  "Collez votre liste (export Moxfield, Archidekt, EDHREC…) : une carte par ligne, ex. « 1 Sol Ring ».": "Paste your list (Moxfield, Archidekt, EDHREC export…): one card per line, e.g. “1 Sol Ring”.",
  "Nom du deck": "Deck name",
  "Cartes en :": "Cards in:",
  "Français": "French",
  "Anglais": "English",
  "Importer les cartes": "Import cards",
  "cliquez sur une carte pour la désigner": "click a card to set it as",
  "commandant ★": "commander ★",
  "(2 max pour Partenaires)": "(max 2 for Partners)",
  "Aucune carte reconnue. Format attendu : « 1 Sol Ring » par ligne.": "No card recognized. Expected format: “1 Sol Ring” per line.",
  "Images indisponibles (réseau bloqué ?) — le deck fonctionnera avec des cartes textuelles.": "Images unavailable (network blocked?) — the deck will work with text cards.",
  "Les cartes jamais imprimées en français restent en anglais.": "Cards never printed in French stay in English.",
  "Enregistrer le deck": "Save deck",
  "Choisissez au moins un commandant ★": "Pick at least one commander ★",
  "Oups, une erreur est survenue": "Oops, something went wrong",
  "Recharger la page": "Reload the page",
  "Préparation de la table…": "Preparing the table…",
  "Micro indisponible. Le chat vocal nécessite HTTPS (ou localhost).": "Microphone unavailable. Voice chat requires HTTPS (or localhost).",
  "Accès au micro refusé ou impossible : ": "Microphone access denied or unavailable: ",
  "Comment jouer": "How to play",
  "Compris !": "Got it!",
};

function typeCat(tl) { tl = (tl || "").toLowerCase(); if (tl.includes("land") || tl.includes("terrain")) return "land"; if (tl.includes("creature") || tl.includes("créature")) return "creature"; return "other"; }

async function fetchScryfall(names, onProgress, lang = "fr") {
  const uniq = [...new Set(names)];
  const imgs = {}; let ok = true;
  // 1) référence anglaise (nom oracle) + type de carte
  for (let i = 0; i < uniq.length; i += 70) {
    const chunk = uniq.slice(i, i + 70);
    try {
      const res = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: chunk.map((n) => ({ name: n })) }),
      });
      const data = await res.json();
      for (const c of data.data || []) {
        const iu = c.image_uris || (c.card_faces && c.card_faces[0].image_uris) || null;
        const e = { s: iu ? iu.small : null, n: iu ? iu.normal : null, t: typeCat(c.type_line) };
        /* Cartes recto-verso (transform, modal_dfc, jetons double face…) : elles n'ont
           PAS d'image_uris à la racine, mais deux faces qui ont chacune la leur.
           Les cartes « split / adventure / flip » ont bien image_uris à la racine :
           ce sont des faces sur une seule image, on ne les traite pas comme du recto-verso. */
        const bf = !c.image_uris && c.card_faces && c.card_faces[1] && c.card_faces[1].image_uris;
        if (bf) {
          e.bs = bf.small; e.bn = bf.normal;
          e.bname = c.card_faces[1].name || null;
          e.ft = typeCat(c.card_faces[0].type_line || "");   // type de la face avant
          e.bt = typeCat(c.card_faces[1].type_line || "");   // type de la face arrière
          /* Le type_line global d'une recto-verso est « Avant // Arrière ». Or typeCat
             teste « land » en premier : « Sorcery // Land » serait classé terrain à tort.
             L'instance démarre toujours sur la face avant, donc on prend son type. */
          e.t = e.ft;
        }
        imgs[c.name.toLowerCase()] = e;
        const short = c.name.split(" // ")[0].toLowerCase();
        if (!imgs[short]) imgs[short] = e;
      }
    } catch (e) { ok = false; }
    if (onProgress) onProgress((lang === "fr" ? 0.45 : 1) * Math.min(1, (i + 70) / uniq.length));
  }
  // 2) impressions françaises (image + nom imprimé), par lots via la recherche Scryfall
  if (lang === "fr") {
    const found = uniq.filter((n) => imgs[n.toLowerCase()]);
    for (let i = 0; i < found.length; i += 10) {
      const chunk = found.slice(i, i + 10);
      const q = `lang:fr (${chunk.map((n) => `!"${n.replace(/"/g, "")}"`).join(" or ")})`;
      try {
        const r = await fetch("https://api.scryfall.com/cards/search?unique=cards&q=" + encodeURIComponent(q));
        if (r.ok) {
          const d = await r.json();
          for (const c of d.data || []) {
            const e = imgs[c.name.toLowerCase()]; if (!e) continue;
            const iu = c.image_uris || (c.card_faces && c.card_faces[0].image_uris) || null;
            if (iu) { e.frs = iu.small; e.frn = iu.normal; }
            e.fr = c.printed_name || (c.card_faces && c.card_faces[0].printed_name) || null;
            // face arrière en français (image + nom imprimé)
            const bf = !c.image_uris && c.card_faces && c.card_faces[1] && c.card_faces[1].image_uris;
            if (bf) {
              e.frbs = bf.small; e.frbn = bf.normal;
              e.frb = c.card_faces[1].printed_name || null;
            }
          }
        }
      } catch (e) {}
      if (onProgress) onProgress(0.45 + 0.55 * Math.min(1, (i + 10) / Math.max(1, found.length)));
      await new Promise((r) => setTimeout(r, 90)); // politesse envers l'API
    }
  }
  return { imgs, ok };
}

function buildInstances(deck) {
  const mk = (name, extra = {}) => {
    const im = deck.imgs[name.toLowerCase()] || {};
    const ov = (deck.arts || {})[name.toLowerCase()] || null;
    const t = im.t || "other";
    /* Recto-verso : on embarque la face arrière (bimg/bimgN/bfn/bname) et le type
       de chaque face, pour pouvoir transformer la carte en jeu. Une illustration
       choisie à la main (ov) remplace la face avant et fournit sa propre arrière. */
    const dfc = ov ? !!ov.bs : !!(im.bs || im.frbs);
    const back = dfc ? (ov ? { s: ov.bs, n: ov.bn, fn: ov.bfn || null }
                           : { s: im.frbs || im.bs, n: im.frbn || im.bn, fn: im.frb || null }) : null;
    return { id: uid(), name, fn: ov ? (ov.fn || null) : (im.fr || null),
      img: ov ? ov.s : (im.frs || im.s || null), imgN: ov ? ov.n : (im.frn || im.n || null),
      ...(dfc ? { dfc: true, flipped: false, bimg: back.s || null, bimgN: back.n || null,
                  bfn: back.fn, bname: im.bname || null,
                  ft: im.ft || t, bt: im.bt || t } : {}),
      t, row: t, host: null, tapped: false, faceDown: false, counters: 0, ...extra };
  };
  const cards = [];
  for (const { count, name } of deck.list) {
    if (deck.commanders.includes(name)) continue;
    for (let i = 0; i < count; i++) cards.push(mk(name));
  }
  const command = deck.commanders.map((name) => mk(name, { isCmdr: true }));
  return { library: shuffleArr(cards), command };
}

/* ---------- styles ---------- */
const CSS = `
:root{ --felt:#0b1518; --panel:#12242a; --panel2:#173037; --line:#28464e; --line2:#39606a;
  --ink:#e9dfc6; --dim:#94aeab; --gold:#d3ab4e; --gold2:#8f6f24; --red:#c14f37; --blue:#3f7fb5; --green:#4f9e6b;
  --railw:216px; --rail2w:236px; }
*{box-sizing:border-box} html,body,#root{height:100%}
body{margin:0; overflow:hidden; background:var(--felt); color:var(--ink);
  font:13px/1.45 -apple-system,'Segoe UI',Roboto,sans-serif; user-select:none;}
.disp{font-family:'Cinzel',Georgia,'Palatino Linotype',serif; letter-spacing:.13em; text-transform:uppercase;}
.app{height:100vh; height:100dvh; display:flex; flex-direction:column; overflow:hidden;}

/* -- table : tapis, vignette -- */
.table-bg{position:fixed; inset:0; z-index:0; pointer-events:none; background:
  radial-gradient(130% 90% at 50% 50%, #14302f 0%, #0e2023 46%, #081113 100%);}
.table-bg::after{content:""; position:absolute; inset:0;
  box-shadow:inset 0 0 180px 40px rgba(0,0,0,.55);}

.btn{background:var(--panel2); color:var(--ink); border:1px solid var(--line); border-radius:8px;
  padding:6px 11px; cursor:pointer; font-size:12.5px; transition:all .15s; white-space:nowrap;}
.btn:hover{border-color:var(--gold); color:#fff;}
.btn.gold{background:linear-gradient(180deg,#e3c065,#a8842f); color:#1c1608; border-color:#efd98f; font-weight:700;}
.btn.gold:hover{filter:brightness(1.08);}
.btn.ghost{background:transparent;}
.btn.danger:hover{border-color:var(--red); color:#ffb3a3;}
.btn:disabled{opacity:.4; cursor:not-allowed;}
input,textarea{background:#0d1c1f; border:1px solid var(--line); color:var(--ink); border-radius:8px; padding:9px 11px; font:inherit; outline:none; width:100%; user-select:text;}
input:focus,textarea:focus{border-color:var(--gold);}
.pips{display:flex; gap:7px; justify-content:center;}
.pip{width:9px;height:9px;border-radius:50%; box-shadow:0 0 8px currentColor;}
.hint{font-size:11px; color:var(--dim);}

/* -- cartes -- */
.card-w{position:relative; flex:none;}
.card-i{width:100%;height:100%;border-radius:5.5%/4%; border-radius:6px; overflow:hidden; background:#1d1a26; border:1px solid #000;
  box-shadow:0 2px 6px rgba(0,0,0,.55); transition:transform .16s ease, box-shadow .16s; cursor:pointer; position:relative;}
.card-i img{width:100%;height:100%;object-fit:cover;display:block; -webkit-user-drag:none;}
.card-i:hover{box-shadow:0 0 0 2px var(--gold), 0 4px 14px rgba(0,0,0,.6); z-index:5;}
.card-i.tapped{transform:rotate(90deg) scale(.86);}
.card-i.cmdr{box-shadow:0 0 0 2px var(--gold), 0 2px 10px rgba(211,171,78,.4);}
.card-txt{position:absolute; inset:0; padding:5px 4px; font-size:9px; line-height:1.15; text-align:center;
  display:flex; flex-direction:column; gap:3px; align-items:center; justify-content:center; background:linear-gradient(160deg,#2b2536,#161320); color:#d9d2e8; word-break:break-word; overflow:hidden;}
.ctpt{font-weight:800; color:var(--gold); background:rgba(0,0,0,.35); border:1px solid var(--gold2); border-radius:8px; padding:0 6px; line-height:1.5; flex:none;}
.grpcard{background:rgba(255,255,255,.035); border:2px dashed var(--gold); display:flex; flex-direction:column;
  gap:4px; align-items:center; justify-content:center; padding:4px; overflow:hidden;}
.grpname{font-family:'Cinzel',Georgia,serif; font-weight:700; text-align:center; word-break:break-word; line-height:1.15;}
.grplbl{font-size:7.5px; letter-spacing:.24em; text-transform:uppercase; color:var(--dim); flex:none;}
.grpdots{position:absolute; top:2px; left:50%; transform:translateX(-50%); display:flex; gap:3px; z-index:6; pointer-events:none;}
.grpdot{width:9px; height:9px; border-radius:50%; border:1px solid rgba(0,0,0,.65); box-shadow:0 0 4px rgba(0,0,0,.8); flex:none;}
a.btn{text-decoration:none; display:inline-flex; align-items:center; gap:4px;}
.donbtn{border-color:rgba(211,171,78,.55); color:var(--gold);}
.donbtn:hover{background:rgba(211,171,78,.12);}
.card-back{background:radial-gradient(circle at 50% 42%, #7a4f1f 0%, #3a2410 34%, #1c1208 72%), #150d05 !important;
  display:flex;align-items:center;justify-content:center; border:1px solid #453015 !important;}
.badge{position:absolute; top:-6px; right:-6px; min-width:19px; height:19px; border-radius:10px; background:var(--gold);
  color:#1c1608; font-weight:800; font-size:11px; display:flex; align-items:center; justify-content:center; padding:0 5px; z-index:6; box-shadow:0 1px 4px #000;}
.bfree{position:relative; flex:none; margin:2px 8px; border-radius:14px; min-height:0; overflow:hidden;}
.band{position:absolute; left:6px; right:6px; border:1px dashed rgba(211,171,78,.10); border-radius:12px; pointer-events:none;}
.bfree:not(.mine) .band{border-color:rgba(148,174,171,.08);}
.bandlbl{position:absolute; left:10px; top:4px; font-size:8.5px; letter-spacing:.24em; text-transform:uppercase;
  color:rgba(233,223,198,.22); font-family:'Cinzel',Georgia,serif;}
.marks{position:absolute; left:2px; right:2px; bottom:2px; display:flex; flex-wrap:wrap; gap:2px; justify-content:center; pointer-events:none; z-index:6;}
.mark{background:rgba(8,17,19,.92); border:1px solid var(--gold2); color:var(--ink); border-radius:8px; padding:0 4px;
  font-size:8.5px; line-height:1.6; max-width:100%; display:flex; align-items:center; gap:2px; box-shadow:0 1px 3px #000;}
.mark .mkn{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;}
.mark .mkv{flex:none; color:var(--gold); font-weight:800;}
.kebab{position:absolute; top:2px; left:2px; z-index:8; width:20px; height:20px; border-radius:50%;
  background:rgba(8,17,19,.92); color:var(--gold); border:1px solid var(--gold); font-size:12px; line-height:1;
  cursor:pointer; opacity:0; transition:opacity .12s; padding:0; display:flex; align-items:center; justify-content:center;}
.card-w:hover .kebab{opacity:1;}
/* pastille « transformer » des cartes recto-verso : discrète, nette au survol */
.dfcbtn{position:absolute; top:2px; left:24px; z-index:8; width:20px; height:20px; border-radius:50%;
  background:rgba(8,17,19,.92); color:var(--gold); border:1px solid var(--gold2); font-size:12px; line-height:1;
  cursor:pointer; opacity:.55; transition:opacity .12s, border-color .12s; padding:0; display:flex; align-items:center; justify-content:center;}
.card-w:hover .dfcbtn{opacity:1; border-color:var(--gold);}
.dfcbtn:hover{color:#fff;}
.att-target{outline:2px dashed var(--gold); outline-offset:3px; border-radius:8px; cursor:crosshair; animation:pulse 1.4s infinite;}
.attbadge{min-width:23px; height:16px; padding:0 5px; border-radius:9px; font-size:10px; font-weight:800; line-height:15px;
  background:rgba(8,17,19,.92); color:var(--gold); border:1px solid var(--gold2); cursor:pointer; white-space:nowrap;
  box-shadow:0 1px 5px rgba(0,0,0,.55); transition:border-color .12s, color .12s;}
.attbadge:hover{border-color:var(--gold); color:#fff;}

/* -- plateau : rangées -- */
.bfrow{position:relative; display:flex; align-items:center; justify-content:center;
  border-radius:10px; transition:background .15s, box-shadow .15s; min-width:0;}
.bfrow.mine{cursor:default;}
.bfrow.over{background:rgba(211,171,78,.07); box-shadow:inset 0 0 0 1px rgba(211,171,78,.5);}
.bfrow .wm{position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font-family:'Cinzel',Georgia,serif; letter-spacing:.35em; text-transform:uppercase; font-size:11px;
  color:rgba(233,223,198,.13); pointer-events:none;}
.bfrow .rlbl{position:absolute; left:6px; top:50%; transform:translateY(-50%) rotate(180deg); writing-mode:vertical-rl;
  font-size:8.5px; letter-spacing:.22em; text-transform:uppercase; color:rgba(233,223,198,.28); pointer-events:none;}

/* -- ligne médiane -- */
.midline{position:relative; height:22px; display:flex; align-items:center; justify-content:center; flex:none;}
.midline::before,.midline::after{content:""; flex:1; height:1px;
  background:linear-gradient(90deg, transparent, var(--line2) 30%, var(--gold2) 100%);}
.midline::after{background:linear-gradient(270deg, transparent, var(--line2) 30%, var(--gold2) 100%);}
.midline .gem{flex:none; margin:0 12px; display:flex; gap:10px; align-items:center;
  font-family:'Cinzel',Georgia,serif; font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--dim); white-space:nowrap;}
.midline .gem b{color:var(--gold); font-weight:700;}
.midline .diam{width:9px; height:9px; background:var(--gold); transform:rotate(45deg);
  box-shadow:0 0 10px rgba(211,171,78,.8); flex:none;}
.midline.pulse .diam{animation:pulse 1.6s infinite;}

/* -- rails -- */
.rail{position:relative; z-index:3; flex:none; display:flex; flex-direction:column; min-height:0;
  overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; scrollbar-color:var(--line2) transparent;
  background:linear-gradient(180deg, rgba(9,18,20,.92), rgba(11,22,25,.88));}
.rail::-webkit-scrollbar{width:7px;}
.rail::-webkit-scrollbar-thumb{background:var(--line2); border-radius:4px;}
.rail.left{width:var(--railw); border-right:1px solid var(--line); padding:10px;}
.rail.right{width:var(--rail2w); border-left:1px solid var(--line); padding:10px;}
.plaque{background:rgba(255,255,255,.028); border:1px solid var(--line); border-radius:14px; padding:10px;}
.plaque .pname{font-family:'Cinzel',Georgia,serif; font-size:12px; letter-spacing:.1em; text-transform:uppercase;
  text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.orb{width:74px; height:74px; border-radius:50%; margin:8px auto 4px; position:relative;
  display:flex; align-items:center; justify-content:center;
  background:radial-gradient(circle at 35% 30%, #2c5a52, #0f2a28 65%, #081514);
  border:2px solid var(--line2); box-shadow:0 0 18px rgba(0,0,0,.6), inset 0 0 14px rgba(0,0,0,.6);}
.orb.me{border-color:var(--gold2); box-shadow:0 0 16px rgba(211,171,78,.25), inset 0 0 14px rgba(0,0,0,.6);}
.orb .n{font-family:'Cinzel',Georgia,serif; font-size:27px; font-weight:700; line-height:1; text-shadow:0 2px 6px #000;}
.orb .n.low{color:#e07b63;}
.lbtn{width:24px;height:24px;border-radius:50%;border:1px solid var(--line);background:var(--panel2);color:var(--ink);cursor:pointer;font-size:13px;line-height:1; padding:0;}
.lbtn:hover{border-color:var(--gold);}
.cmdmg{display:flex; align-items:center; justify-content:center; gap:7px; margin-top:6px;}

/* piles compactes */
.mpiles{display:flex; gap:8px; justify-content:center; margin-top:10px; flex-wrap:wrap;}
.mpile{width:44px; flex:none; text-align:center; position:relative;}
.mpile .mp-c{width:44px; height:61px; border-radius:5px; border:1px solid var(--line); background:#0d1c1f;
  position:relative; overflow:hidden; cursor:pointer; transition:border-color .15s, box-shadow .15s; margin:0 auto;}
.mpile .mp-c:hover{border-color:var(--gold);}
.mpile .mp-c img{width:100%;height:100%;object-fit:cover;}
.mpile .mp-c.drop-over{border-color:var(--gold); box-shadow:0 0 0 1px var(--gold);}
.mpile .mp-n{position:absolute; top:38px; left:50%; transform:translateX(-50%); background:#0a1416ee; border:1px solid var(--line);
  border-radius:8px; padding:0 6px; font-size:10.5px; font-weight:700; z-index:2;}
.mpile .mp-l{font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--dim); margin-top:9px;}

/* -- main en éventail -- */
.handzone{position:relative; z-index:4; flex:none;}
.hcard{position:absolute; bottom:0; transition:transform .18s ease, filter .18s; will-change:transform;
  transform:translateX(-50%) rotate(var(--rot)) translateY(var(--dy));}
.hcard:hover{z-index:60 !important; transform:translateX(-50%) rotate(0deg) translateY(calc(var(--dy) - 11vh)) scale(1.55);
  filter:drop-shadow(0 14px 30px rgba(0,0,0,.75));}
body.en .handzone.drop-over::after{content:"Return to hand" !important;}
.handzone.drop-over::after{content:"Reprendre en main"; position:absolute; inset:6px; border:1px dashed var(--gold);
  border-radius:12px; display:flex; align-items:center; justify-content:center; color:var(--gold); font-size:11px;
  letter-spacing:.2em; text-transform:uppercase; pointer-events:none; background:rgba(211,171,78,.05);}
.opphand{position:absolute; top:-14px; left:50%; transform:translateX(-50%); z-index:2; pointer-events:none; display:flex;}
.opphand .oh{width:34px; height:48px; margin:0 -11px; border-radius:4px; transform:rotate(180deg);
  box-shadow:0 2px 6px rgba(0,0,0,.6);}

/* -- bouton de tour (rail droit) -- */
.turnbtn{width:96px; height:96px; border-radius:50%; margin:12px auto; flex:none; cursor:pointer;
  font-family:'Cinzel',Georgia,serif; font-size:12px; letter-spacing:.1em; text-transform:uppercase; font-weight:700;
  border:3px solid #efd98f; color:#241b06; line-height:1.25; padding:8px;
  background:radial-gradient(circle at 38% 30%, #f0d47e, #c69a3a 58%, #8f6f24);
  box-shadow:0 0 22px rgba(211,171,78,.45), inset 0 -4px 10px rgba(0,0,0,.25); transition:all .2s;}
.turnbtn:hover{filter:brightness(1.08); transform:scale(1.03);}
.turnbtn:disabled{cursor:default; transform:none; filter:none; color:var(--dim); border-color:var(--line2);
  background:radial-gradient(circle at 38% 30%, #1d3a40, #122529 60%, #0b1518); box-shadow:inset 0 0 16px rgba(0,0,0,.5);}

/* -- écrans peu hauts : version compacte des rails -- */
@media (max-height: 830px){
  .rail.left,.rail.right{padding:8px;}
  .plaque{padding:7px;}
  .orb{width:58px; height:58px; margin:6px auto 3px;}
  .orb .n{font-size:21px;}
  .mpile{width:38px;}
  .mpile .mp-c{width:38px; height:53px;}
  .mpile .mp-n{top:32px;}
  .mpiles{margin-top:7px; gap:6px;}
  .cmdmg{margin-top:4px;}
  .turnbtn{width:78px; height:78px; margin:8px auto; font-size:10.5px;}
}

/* -- barre du haut -- */
.topbar{position:relative; z-index:5; flex:none; height:42px; display:flex; align-items:center; gap:12px;
  padding:0 12px; border-bottom:1px solid var(--line); background:rgba(6,13,15,.85);}

/* -- journal -- */
.log{font-size:11.5px; color:var(--dim); overflow-y:auto; display:flex; flex-direction:column-reverse; gap:3px; min-height:0;}
.log b{color:var(--ink);}

/* -- menus, modales, aperçu -- */
.menu{position:fixed; z-index:100; background:#101f23; border:1px solid var(--gold); border-radius:10px; padding:5px; min-width:190px; max-height:calc(100vh - 12px); max-height:calc(100dvh - 12px); overflow-y:auto; box-shadow:0 10px 30px rgba(0,0,0,.7);}
.menu button{display:block; width:100%; text-align:left; background:none; border:none; color:var(--ink); padding:6px 10px; border-radius:6px; cursor:pointer; font-size:12.5px;}
.menu button:hover{background:var(--panel2); color:#fff;}
.menu .sec{padding:5px 10px 2px; font-size:9px; letter-spacing:.14em; color:var(--dim); text-transform:uppercase; border-top:1px solid var(--line); margin-top:3px;}
.modal-bg{position:fixed; inset:0; background:rgba(4,10,11,.78); z-index:90; display:flex; align-items:center; justify-content:center; padding:20px;}
.modal{background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:20px; max-width:860px; width:100%; max-height:88vh; max-height:88dvh; overflow:auto;}
/* aperçu en grand : conteneur pleine hauteur, contenu centré et borné pour
   qu'il reste TOUJOURS entièrement visible (jamais coupé en haut/bas), et
   au-dessus des modales (z-index 200 > modale 90, menu 100). */
.preview{position:fixed; left:calc(var(--railw) + 14px); top:8px; bottom:8px; z-index:200;
  width:min(300px, 23vw); pointer-events:none; filter:drop-shadow(0 10px 30px rgba(0,0,0,.85));
  display:flex; flex-direction:column; justify-content:center; align-items:flex-start; gap:6px;}
.preview img{width:100%; max-height:62vh; object-fit:contain; border-radius:12px;}
.preview .pv-txtwrap{width:100%;}
/* quand une fenêtre de recherche est ouverte, on colle l'aperçu au bord
   gauche pour qu'il ne recouvre pas la fenêtre (et reste bien visible). */
body.has-modal .preview{left:10px;}
.pv-marks{margin-top:0; display:flex; flex-direction:column; gap:3px; max-height:26vh; overflow:auto; width:100%;}
.pv-mark{background:rgba(8,17,19,.96); border:1px solid var(--gold2); border-radius:8px; padding:3px 9px; font-size:12.5px; color:var(--ink);}
.pv-mark b{color:var(--gold);}
/* pendant un glisser-déposer : on cache l'aperçu et on neutralise le zoom
   des cartes en main pour qu'elles ne gênent pas la pose sur le plateau */
body.dragging .preview{display:none;}
body.dragging .hcard{pointer-events:none;}
.pchips{display:flex; align-items:center; gap:5px; margin-left:10px; overflow:hidden; flex-wrap:nowrap;}
.pchip{display:flex; align-items:center; gap:4px; padding:2px 8px; font-size:11px; border-radius:20px; cursor:pointer;
  background:rgba(255,255,255,.04); border:1px solid var(--line2); color:var(--ink); white-space:nowrap; line-height:1.5;}
.pchip:hover{border-color:var(--gold);}
.pchip.isme{cursor:default; opacity:.85;}
.pchip.shown{border-color:var(--gold); box-shadow:0 0 0 1px var(--gold);}
.pchip.turn{background:rgba(211,171,78,.16);}
.pchip.dead{opacity:.45; text-decoration:line-through;}
.alivecount{margin-left:4px; padding:2px 10px; border-radius:20px; font-size:11px; font-weight:800; white-space:nowrap;
  color:#1c1608; background:var(--gold); box-shadow:0 1px 6px rgba(211,171,78,.4);}
.oppnav{display:flex; align-items:center; justify-content:space-between; gap:4px; margin-bottom:4px;}
.oppnav .btn{padding:2px 10px;}
.banner{position:fixed; top:52px; left:50%; transform:translateX(-50%); z-index:95; background:#241d0a;
  border:1px solid var(--gold); color:var(--gold); border-radius:24px; padding:7px 16px;
  box-shadow:0 8px 24px rgba(0,0,0,.65); display:flex; gap:12px; align-items:center; font-size:13px;}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
.wait{animation:pulse 1.6s infinite;}
@media (prefers-reduced-motion: reduce){ *{transition:none !important; animation:none !important;} }

/* -- lobby (cet écran-là a le droit de défiler) -- */
.lobbywrap{height:100vh; height:100dvh; overflow:auto; position:relative; z-index:1;}
.deckcard{display:flex; gap:12px; align-items:center; background:var(--panel2); border:2px solid var(--line); border-radius:14px; padding:10px; cursor:pointer; transition:all .15s; text-align:left; width:100%;}
.deckcard:hover{border-color:#3d6069;}
.deckcard.sel{border-color:var(--gold); box-shadow:0 0 0 1px var(--gold), 0 6px 18px rgba(211,171,78,.15);}
.deckcard img{width:52px; height:73px; object-fit:cover; border-radius:5px; flex:none;}
.artbtn{position:absolute; bottom:3px; right:3px; z-index:8; width:22px; height:22px; padding:0; line-height:1;
  background:rgba(8,17,19,.85); border:1px solid var(--line2); border-radius:6px; cursor:pointer; font-size:12px;}
.artbtn:hover{border-color:var(--gold); background:#101f23;}
.row{display:flex; gap:10px; align-items:center; flex-wrap:wrap;}
.lobby-grid{display:grid; grid-template-columns:1fr 1fr; gap:18px;}
@media (max-width:760px){ .lobby-grid{grid-template-columns:1fr;} }
@media (max-width:1060px){ :root{--railw:178px; --rail2w:196px;} .orb{width:62px;height:62px;} .orb .n{font-size:22px;} }
`;

const Pips = ({ size = 9 }) => (
  <div className="pips">{MANA.map((c, i) => <span key={i} className="pip" style={{ background: c, color: c, width: size, height: size }} />)}</div>
);

/* ---------- carte ---------- */
function Card({ card, w = 76, mine = true, zone, onTap, onMenu, onHover, onTransform, big = false }) {
  const h = Math.round(w * 1.4);
  const inner = card.faceDown ? (
    <div className={"card-i card-back" + (card.tapped ? " tapped" : "")}><Pips size={5} /></div>
  ) : card.grp ? (
    <div className={"card-i grpcard" + (card.tapped ? " tapped" : "")} style={{ borderColor: card.color || "var(--gold)" }}>
      <div className="grpname" style={{ color: card.color || "var(--gold)", fontSize: Math.max(8, Math.round(w / 7)) }}>{card.name}</div>
      <div className="grplbl">groupe</div>
    </div>
  ) : (
    <div className={"card-i" + (card.tapped ? " tapped" : "") + (card.isCmdr ? " cmdr" : "")}>
      {fimg(card) ? <img src={big ? (fimgN(card) || fimg(card)) : fimg(card)} alt={dn(card)} draggable={false} /> : (
        <div className="card-txt" style={{ fontSize: Math.max(7.5, Math.round(w / 7.5)) }}>
          <div>{dn(card)}</div>
          {card.pt && <div className="ctpt" style={{ fontSize: Math.max(9, Math.round(w / 5.5)) }}>{card.pt}</div>}
        </div>
      )}
    </div>
  );
  return (
    <div className="card-w" style={{ width: w, height: h }}
      draggable={mine}
      onDragStart={(e) => { if (!mine) return; e.dataTransfer.setData("text/plain", JSON.stringify({ id: card.id, from: zone })); if (onHover) onHover(null); }}
      onClick={(e) => { e.stopPropagation(); if (onTap) onTap(card); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (onMenu) onMenu(e, card, zone); }}
      onMouseEnter={() => onHover && onHover(card)}
      onMouseLeave={() => onHover && onHover(null)}
      title={mine ? "" : card.faceDown ? "" : dn(card)}
    >
      {inner}
      {onMenu && !card.faceDown && (
        <button className="kebab" title="Actions"
          onClick={(e) => { e.stopPropagation(); onMenu(e, card, zone); }}
          onDragStart={(e) => e.preventDefault()}>⋮</button>
      )}
      {onTransform && card.dfc && !card.faceDown && (
        <button className="dfcbtn" title={t("Transformer (recto-verso)")}
          onClick={(e) => { e.stopPropagation(); onTransform(card.id); }}
          onDragStart={(e) => e.preventDefault()}>⟳</button>
      )}
      {card.counters > 0 && !card.faceDown && <div className="badge">{card.counters}</div>}
      {!card.faceDown && card.marks && Object.keys(card.marks).length > 0 && (
        <div className="marks">{Object.entries(card.marks).map(([k, v]) => <div key={k} className="mark"><span className="mkn">{k}</span>{v > 1 && <b className="mkv">×{v}</b>}</div>)}</div>
      )}
      {!card.faceDown && card.groups && Object.keys(card.groups).length > 0 && (
        <div className="grpdots">{Object.entries(card.groups).map(([gid, col]) => <span key={gid} className="grpdot" style={{ background: col }} />)}</div>
      )}
    </div>
  );
}

/* ---------- constructeur de deck ---------- */
function DeckBuilder({ onSave, onClose, existing }) {
  const [name, setName] = useState(existing ? existing.name : "");
  const [text, setText] = useState(existing ? existing.list.map((l) => `${l.count} ${l.name}`).join("\n") : "");
  const [parsed, setParsed] = useState(existing ? existing.list : null);
  const [imgs, setImgs] = useState(existing ? existing.imgs : {});
  const [arts, setArts] = useState(existing ? existing.arts || {} : {});
  const [artFor, setArtFor] = useState(null); // nom de carte dont on choisit l'illustration
  const [cmdrs, setCmdrs] = useState(existing ? existing.commanders : []);
  const [lang, setLang] = useState(existing ? existing.lang || "fr" : "fr");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(0);
  const [warn, setWarn] = useState("");

  const doImport = async () => {
    const list = parseDecklist(text);
    if (!list.length) { setWarn(t("Aucune carte reconnue. Format attendu : « 1 Sol Ring » par ligne.")); return; }
    setBusy(true); setWarn(""); setProg(0);
    const { imgs: im, ok } = await fetchScryfall(list.map((l) => l.name), setProg, lang);
    setImgs(im); setParsed(list); setBusy(false);
    if (!ok || Object.keys(im).length === 0) setWarn(t("Images indisponibles (réseau bloqué ?) — le deck fonctionnera avec des cartes textuelles."));
    setCmdrs((c) => c.filter((n) => list.some((l) => l.name === n)));
  };

  const total = parsed ? parsed.reduce((s, l) => s + l.count, 0) : 0;
  const toggleCmdr = (n) => setCmdrs((c) => c.includes(n) ? c.filter((x) => x !== n) : c.length >= 2 ? c : [...c, n]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="disp" style={{ margin: "0 0 4px", fontSize: 17, color: "var(--gold)" }}>{existing ? t("Modifier le deck") : t("Nouveau deck")}</h2>
        <p className="hint" style={{ marginTop: 0 }}>{t("Collez votre liste (export Moxfield, Archidekt, EDHREC…) : une carte par ligne, ex. « 1 Sol Ring ».")}</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <input placeholder={t("Nom du deck")} value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 300 }} />
          <span className="hint">{t("Cartes en :")}</span>
          <button className={"btn" + (lang === "fr" ? " gold" : "")} onClick={() => setLang("fr")}>{t("Français")}</button>
          <button className={"btn" + (lang === "en" ? " gold" : "")} onClick={() => setLang("en")}>{t("Anglais")}</button>
        </div>
        <textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder={"1 Atraxa, Praetors' Voice\n1 Sol Ring\n1 Command Tower\n38 Forest\n..."} spellCheck={false} />
        <div className="row" style={{ margin: "10px 0" }}>
          <button className="btn gold" onClick={doImport} disabled={busy}>{busy ? `Import… ${Math.round(prog * 100)}%` : t("Importer les cartes")}</button>
          {parsed && <span className="hint">{total} {t("cartes")} · {t("cliquez sur une carte pour la désigner")} <b style={{ color: "var(--gold)" }}>{t("commandant ★")}</b> {t("(2 max pour Partenaires)")}</span>}
        </div>
        {warn && <div style={{ color: "#e0a090", fontSize: 12, marginBottom: 8 }}>{warn}</div>}
        {existing && !busy && (
          <div className="hint" style={{ marginBottom: 8 }}>
            {t("Deck importé avant la prise en charge du recto-verso ? Recliquez sur « Importer les cartes » pour récupérer les faces arrière.")}
          </div>
        )}
        {parsed && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxHeight: 300, overflow: "auto", padding: 4, background: "rgba(0,0,0,.25)", borderRadius: 10 }}>
            {parsed.map((l, i) => {
              const im = imgs[l.name.toLowerCase()]; const isC = cmdrs.includes(l.name);
              const ov = arts[l.name.toLowerCase()];
              const src = ov ? ov.s : (im && (im.frs || im.s)) || null;
              return (
                <div key={i} onClick={() => toggleCmdr(l.name)} style={{ width: 82, cursor: "pointer", position: "relative" }} title={im && im.fr ? im.fr : l.name}>
                  <div className={"card-i" + (isC ? " cmdr" : "")} style={{ height: 114 }}>
                    {src ? <img src={src} alt={l.name} /> : <div className="card-txt">{l.name}</div>}
                  </div>
                  {l.count > 1 && <div className="badge">×{l.count}</div>}
                  {isC && <div style={{ position: "absolute", top: 2, left: 4, color: "var(--gold)", fontSize: 16, textShadow: "0 1px 3px #000" }}>★</div>}
                  <button className="artbtn" title={t("Choisir l'illustration")} style={ov ? { borderColor: "var(--gold)", color: "var(--gold)" } : null}
                    onClick={(e) => { e.stopPropagation(); setArtFor(l.name); }}>🎨</button>
                </div>
              );
            })}
          </div>
        )}
        {parsed && lang === "fr" && <div className="hint" style={{ marginTop: 6 }}>{t("Les cartes jamais imprimées en français restent en anglais.")}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose}>{t("Annuler")}</button>
          <button className="btn gold" disabled={!parsed || !name.trim() || cmdrs.length === 0}
            onClick={() => onSave({ id: existing ? existing.id : uid(), name: name.trim(), list: parsed, imgs, arts, commanders: cmdrs, lang })}>
            {t("Enregistrer le deck")}
          </button>
        </div>
        {parsed && cmdrs.length === 0 && <div className="hint" style={{ textAlign: "right", marginTop: 4 }}>{t("Choisissez au moins un commandant ★")}</div>}
      </div>
      {artFor && <ArtPicker card={{ name: artFor, fn: (imgs[artFor.toLowerCase()] || {}).fr || null }} showAll={false}
        close={() => setArtFor(null)}
        onPick={(p) => {
          setArts((a) => {
            const na = { ...a };
            if (p) na[artFor.toLowerCase()] = { s: p.s, n: p.n, fn: p.fn || null, set: p.set }; else delete na[artFor.toLowerCase()];
            return na;
          });
          setArtFor(null);
        }} />}
    </div>
  );
}

/* ---------- lobby ---------- */
function Lobby({ onStart, uiLang, onLang }) {
  const [pname, setPname] = useState("");
  const [decks, setDecks] = useState([]);
  const [selDeck, setSelDeck] = useState(null);
  const [builder, setBuilder] = useState(false);
  const [editDeck, setEditDeck] = useState(null);
  const [joinCode, setJoinCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  useEffect(() => { (async () => {
    const d = await sget("mtg-decks"); if (d) setDecks(d);
    const n = await sget("mtg-name"); if (n) setPname(n);
  })(); }, []);

  const saveDecks = async (list) => { setDecks(list); await sset("mtg-decks", list); };
  const ready = pname.trim() && selDeck;

  const createRoom = async () => {
    setBusy(true); setErr("");
    const code = makeCode();
    const meta = { code, created: Date.now(), names: { P1: pname.trim() }, order: ["P1"], turn: "P1", turnNo: 1 };
    await sset(`mtgr-${code}-meta`, meta, true);
    await sset("mtg-name", pname.trim());
    onStart({ code, seat: "P1", deck: selDeck, pname: pname.trim() });
  };

  const joinRoom = async () => {
    setBusy(true); setErr("");
    const code = joinCode.trim().toUpperCase();
    const meta = await sget(`mtgr-${code}-meta`, true);
    if (!meta) { setErr(t("Salon introuvable. Vérifiez le code (et que vous utilisez le même lien d'app que votre ami).")); setBusy(false); return; }
    if (!meta.order) meta.order = Object.keys(meta.names || {});
    const nm = pname.trim();
    let seat = meta.order.find((sx) => (meta.names[sx] || "").toLowerCase() === nm.toLowerCase()); // reconnexion
    if (!seat) {
      if (meta.order.length >= 6) { setErr(t("Salon complet (6 joueurs max).")); setBusy(false); return; }
      seat = "P" + (meta.order.reduce((mx, sx) => Math.max(mx, parseInt(sx.slice(1), 10) || 0), 0) + 1);
      meta.order = [...meta.order, seat]; meta.names[seat] = nm;
      await sset(`mtgr-${code}-meta`, meta, true);
    }
    await sset("mtg-name", nm);
    onStart({ code, seat, deck: selDeck, pname: nm });
  };

  return (
    <div className="lobbywrap">
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "34px 18px 60px", width: "100%" }}>
      <div style={{ textAlign: "center", marginBottom: 26 }}>
        <Pips />
        <h1 className="disp" style={{ fontSize: 32, margin: "12px 0 4px", color: "var(--ink)", textShadow: "0 2px 12px rgba(211,171,78,.25)" }}>Table Commander</h1>
        <div className="hint">{t("Simulateur manuel pour 2 à 6 joueurs · vous résolvez les effets vous-mêmes, comme sur une vraie table")}</div>
        <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
          {DONATION_URL && (
            <a className="btn ghost donbtn" href={DONATION_URL} target="_blank" rel="noopener noreferrer">{t("❤ Soutenir le projet")}</a>
          )}
          <button className="btn ghost" title="Langue / Language" onClick={() => onLang(uiLang === "fr" ? "en" : "fr")}>
            🌐 {uiLang === "fr" ? "English" : "Français"}
          </button>
        </div>
      </div>

      <div className="lobby-grid">
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 16, padding: 18 }}>
          <h3 className="disp" style={{ margin: "0 0 10px", fontSize: 13, color: "var(--gold)" }}>{t("1 · Joueur & deck")}</h3>
          <input placeholder={t("Votre pseudo")} value={pname} onChange={(e) => setPname(e.target.value)} style={{ marginBottom: 12 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflow: "auto" }}>
            {decks.map((d) => {
              const im = d.imgs[d.commanders[0] ? d.commanders[0].toLowerCase() : ""];
              const n = d.list.reduce((s, l) => s + l.count, 0);
              const cn = d.commanders.map((c) => { const e = d.imgs[c.toLowerCase()]; return (e && e.fr) || c; });
              return (
                <div key={d.id} className={"deckcard" + (selDeck && selDeck.id === d.id ? " sel" : "")} onClick={() => setSelDeck(d)}>
                  {im && (im.frs || im.s) ? <img src={im.frs || im.s} alt="" /> : <div className="card-i" style={{ width: 52, height: 73, flex: "none" }}><div className="card-txt">{d.commanders[0]}</div></div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{d.name}</div>
                    <div className="hint" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>★ {cn.join(" & ")} · {n} {t("cartes")}{d.lang === "fr" ? " · FR" : ""}</div>
                  </div>
                  <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setEditDeck(d); setBuilder(true); }}>✎</button>
                  <button className="btn ghost danger" onClick={(e) => { e.stopPropagation(); if (confirmDel === d.id) { const nl = decks.filter((x) => x.id !== d.id); saveDecks(nl); if (selDeck && selDeck.id === d.id) setSelDeck(null); setConfirmDel(null); } else setConfirmDel(d.id); }}>{confirmDel === d.id ? t("Sûr ?") : "✕"}</button>
                </div>
              );
            })}
            {decks.length === 0 && <div className="hint" style={{ padding: 12, textAlign: "center" }}>{t("Aucun deck enregistré — créez-en un ci-dessous. Vos decks sont sauvegardés pour les prochaines parties.")}</div>}
          </div>
          <button className="btn" style={{ marginTop: 10, width: "100%" }} onClick={() => { setEditDeck(null); setBuilder(true); }}>{t("+ Importer un deck")}</button>
        </div>

        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 16, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <h3 className="disp" style={{ margin: 0, fontSize: 13, color: "var(--gold)" }}>{t("2 · Rejoindre la table")}</h3>
          <div>
            <button className="btn gold" style={{ width: "100%", padding: "12px" }} disabled={!ready || busy} onClick={createRoom}>{t("Créer un salon")}</button>
            <div className="hint" style={{ marginTop: 6 }}>{t("Un code à 6 caractères sera généré : envoyez-le à vos amis (jusqu'à 6 joueurs).")}</div>
          </div>
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <div className="row">
              <input placeholder="CODE" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} maxLength={8}
                style={{ maxWidth: 120, textAlign: "center", letterSpacing: ".3em", fontWeight: 800, fontSize: 17 }} />
              <button className="btn" disabled={!ready || joinCode.length < 4 || busy} onClick={joinRoom}>{t("Rejoindre")}</button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>{t("Entrez le code reçu de votre ami.")}</div>
          </div>
          {err && <div style={{ color: "#e0a090", fontSize: 12 }}>{err}</div>}
          {!ready && <div className="hint">{t("→ Choisissez un pseudo et un deck pour continuer.")}</div>}
          <div className="hint" style={{ marginTop: "auto", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            {t("⚠ Les salons utilisent le stockage partagé de cette app : toute personne ayant le lien peut voir les parties. Jouez entre amis !")}
          </div>
        </div>
      </div>

      {builder && <DeckBuilder existing={editDeck} onClose={() => setBuilder(false)}
        onSave={async (deck) => { const nl = editDeck ? decks.map((d) => (d.id === deck.id ? deck : d)) : [...decks, deck]; await saveDecks(nl); setSelDeck(deck); setBuilder(false); }} />}
      <div className="hint" style={{ textAlign: "center", marginTop: 26, fontSize: 10.5, lineHeight: 1.7, opacity: .85 }}>
        {UI_LANG === "en" ? <>
          Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards of the Coast.<br />
          Card images and data © Wizards of the Coast, provided via Scryfall.<br />
          No account, no personal data stored: only game rooms are kept temporarily. Voice chat is peer-to-peer and never recorded.
        </> : <>
          Contenu de fan non officiel, dans le cadre de la Fan Content Policy — ni approuvé ni sponsorisé par Wizards of the Coast.<br />
          Images et données des cartes © Wizards of the Coast, fournies via Scryfall.<br />
          Aucun compte, aucune donnée personnelle stockée : seuls les salons de jeu sont conservés temporairement. Le vocal est en pair-à-pair et n'est jamais enregistré.
        </>}
      </div>
    </div>
    </div>
  );
}

/* ---------- plateau de jeu ---------- */
/* liste des marqueurs affichée sous l'aperçu en grand */
function PreviewMarks({ card }) {
  const hasMarks = card.marks && Object.keys(card.marks).length > 0;
  if (!hasMarks && !(card.counters > 0)) return null;
  return (
    <div className="pv-marks">
      {card.counters > 0 && <div className="pv-mark"><b>{card.counters}</b> {card.counters > 1 ? t("marqueurs") : t("marqueur")}</div>}
      {hasMarks && Object.entries(card.marks).map(([k, v]) => <div key={k} className="pv-mark">{k} <b>×{v}</b></div>)}
    </div>
  );
}

/* positions verticales (0..1) des trois bandes du champ de bataille libre */
const BANDS = { creature: 0.18, other: 0.5, land: 0.84 };

const ZLBL = { hand: "la main", battlefield: "le champ de bataille", graveyard: "le cimetière", exile: "l'exil", library: "la bibliothèque", command: "la zone de commandement" };
const ROWNAME = { land: "Terrains", creature: "Créatures", other: "Artefacts · Enchantements · Autres" };

function Stack({ host, atts, w, off, mine, mirror, collapsed, onToggle, onTap, onMenu, onHover, onTransform, onAttachDrop, attachTarget }) {
  const h = Math.round(w * 1.4);
  const n = atts.length;
  /* La carte HÔTE reste ancrée à sa position de pose (elle ne bouge jamais,
     quel que soit le nombre d'équipements) : on la garde toujours visible et
     survolable. Les attachements se déploient vers le bord EXTÉRIEUR du joueur
     (vers le haut pour l'adversaire, vers le bas pour soi), donc à l'écart de
     la ligne médiane où ils seraient rognés. Le décalage se resserre quand il y
     en a beaucoup ; « rangé » (collapsed) les glisse presque sous l'hôte. */
  const spread = collapsed ? 3 : (n ? Math.min(off, Math.round((h * 1.15) / n)) : off);
  const dir = mirror ? -1 : 1; // adversaire (miroir) : vers le haut ; moi : vers le bas
  return (
    <div className={attachTarget ? "att-target" : ""}
      style={{ position: "relative", width: w + (n ? 12 : 0), height: h, flex: "none" }}
      onDragOver={mine ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
      onDrop={mine ? (e) => { e.preventDefault(); e.stopPropagation(); try { const d = JSON.parse(e.dataTransfer.getData("text/plain")); onAttachDrop(host, d); } catch (er) {} } : undefined}
    >
      {atts.map((a, i) => (
        <div key={a.id} style={{ position: "absolute", top: dir * (n - i) * spread, left: 12, zIndex: i + 1 }}>
          <Card card={a} w={w - 12} mine={mine} zone="battlefield" onTap={onTap} onMenu={onMenu} onHover={onHover} onTransform={onTransform} />
        </div>
      ))}
      <div style={{ position: "absolute", top: 0, left: 0, zIndex: n + 2 }}>
        <Card card={host} w={w} mine={mine} zone="battlefield" onTap={onTap} onMenu={onMenu} onHover={onHover} onTransform={onTransform} />
      </div>
      {n > 0 && onToggle && (
        <button className="attbadge" style={{ position: "absolute", top: h - 15, left: w - 27, zIndex: n + 3 }}
          onClick={(e) => { e.stopPropagation(); onToggle(host.id); }}
          onDragStart={(e) => e.preventDefault()}
          title={collapsed ? t("Déployer les équipements") : t("Ranger les équipements")}>
          ⚔ {n} {collapsed ? "▸" : "▾"}
        </button>
      )}
    </div>
  );
}

/* Une rangée du plateau : hauteur fixe, jamais de retour à la ligne.
   Quand il y a trop de cartes, elles se chevauchent (compression). */
/* Champ de bataille en placement libre.
   Chaque carte a des coordonnées normalisées (bx, by dans 0..1 = centre de la
   carte) exprimées dans le repère de SON propriétaire ; l'adversaire est
   affiché en miroir vertical, comme un vrai face-à-face. Trois bandes
   translucides rappellent les zones classiques (visuel seulement). */
function Battlefield({ cards, mine, mirror, areaH, areaW, cardHFix, snap, onPlace, onTap, onMenu, onHover, onTransform, onAttachDrop, attachMode, waiting }) {
  const ref = useRef(null);
  const [mw, setMw] = useState(0);
  const [tucked, setTucked] = useState({}); // id hôte -> équipements rangés (repliés)
  const toggleTuck = (id) => setTucked((m) => ({ ...m, [id]: !m[id] }));
  useLayoutEffect(() => { if (ref.current) setMw(ref.current.clientWidth); }, [areaW, areaH]);
  const hosts = cards.filter((c) => !c.host);
  const attOf = (id) => cards.filter((c) => c.host === id);
  const H = Math.max(70, areaH || 200), W = Math.max(160, mw || (areaW || 616) - 16);
  const cardH = Math.max(56, cardHFix || Math.round(H * 0.30));
  const w = Math.round(cardH / 1.4);
  /* position de secours pour les cartes sans coordonnées (anciennes parties) */
  const fb = {};
  { const per = {};
    for (const c of hosts) if (c.bx == null || c.by == null) {
      const r = c.row || c.t || "other"; const k = per[r] = (per[r] || 0) + 1;
      fb[c.id] = { x: Math.min(0.94, 0.06 + (k - 1) * ((w + 10) / W)), y: BANDS[r] || 0.5 };
    } }
  /* miroir compressé : créatures adverses contre la ligne médiane (bas),
     terrains vers le haut mais sous leur main. 0.18→0.82 · 0.5→0.55 · 0.84→0.26 */
  const mirrorY = (y) => Math.min(0.94, Math.max(0.08, 0.973 - 0.848 * y));
  const posOf = (c) => {
    let x = c.bx != null ? c.bx : fb[c.id].x, y = c.by != null ? c.by : fb[c.id].y;
    if (mirror) y = mirrorY(y);
    return { x, y };
  };
  const clampSnap = (nx, ny) => {
    if (snap) {
      const gx = (w + 10) / W, x0 = (w / 2 + 8) / W;
      nx = x0 + Math.round((nx - x0) / gx) * gx;
      let best = "other", bd = 9;
      for (const r of Object.keys(BANDS)) { const d = Math.abs(ny - BANDS[r]); if (d < bd) { bd = d; best = r; } }
      ny = BANDS[best];
    }
    const mx = (w / 2 + 4) / W, my2 = (cardH / 2 + 4) / H;
    return { x: Math.min(1 - mx, Math.max(mx, nx)), y: Math.min(1 - my2, Math.max(my2, ny)) };
  };
  return (
    <div ref={ref} className={"bfree" + (mine ? " mine" : "")} style={{ height: H }}
      onDragOver={mine ? (e) => e.preventDefault() : undefined}
      onDrop={mine ? (e) => {
        e.preventDefault();
        try {
          const d = JSON.parse(e.dataTransfer.getData("text/plain"));
          const r = ref.current.getBoundingClientRect();
          const p = clampSnap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          onPlace(d.id, d.from, p.x, p.y);
        } catch (er) {}
      } : undefined}
    >
      {["creature", "other", "land"].map((r) => {
        const y = mirror ? mirrorY(BANDS[r]) : BANDS[r];
        return (
          <div key={r} className="band" style={{ top: `calc(${(y * 100).toFixed(1)}% - ${Math.round(cardH / 2) + 6}px)`, height: cardH + 12 }}>
            {mine && <span className="bandlbl">{t(ROWNAME[r]).split(" ")[0]}</span>}
          </div>
        );
      })}
      {hosts.length === 0 && waiting && <div className="wm" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>{waiting}</div>}
      {hosts.map((c) => {
        const p = posOf(c);
        return (
          <div key={c.id} style={{ position: "absolute", left: Math.round(p.x * W - w / 2), top: Math.round(p.y * H - cardH / 2) }}>
            <Stack host={c} atts={attOf(c.id)} w={w} off={20} mine={mine} mirror={mirror} collapsed={!!tucked[c.id]} onToggle={toggleTuck} onTap={onTap} onMenu={onMenu} onHover={onHover} onTransform={onTransform}
              onAttachDrop={onAttachDrop} attachTarget={!!attachMode && mine && attachMode !== c.id} />
          </div>
        );
      })}
    </div>
  );
}

/* ---------- main en éventail ---------- */
function HandFan({ cards, vh, zoneW, onPlay, onMenu, onHover, onDropCard }) {
  const [over, setOver] = useState(false);
  const n = cards.length;
  const h = Math.round(vh * 0.155), w = Math.round(h / 1.4);
  const stripH = Math.round(vh * 0.135);
  const safeW = zoneW > 0 ? zoneW : Math.round(window.innerWidth * 0.55);
  const maxSpan = Math.max(0, Math.min(safeW - w - 40, n * w * 0.78));
  const step = n > 1 ? maxSpan / (n - 1) : 0;
  const mid = (n - 1) / 2;
  return (
    <div className={"handzone" + (over ? " drop-over" : "")} style={{ height: stripH }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); try { const d = JSON.parse(e.dataTransfer.getData("text/plain")); onDropCard(d.id, d.from); } catch (er) {} }}
    >
      {n === 0 && <div className="wm" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(233,223,198,.18)", letterSpacing: ".3em", fontSize: 11, fontFamily: "'Cinzel',Georgia,serif", textTransform: "uppercase" }}>Main vide</div>}
      {cards.map((c, i) => {
        const rot = n > 1 ? ((i - mid) / mid || 0) * Math.min(9, n * 1.4) : 0;
        const dy = Math.abs(i - mid) * Math.min(5, 26 / Math.max(1, n)) + 4;
        return (
          <div key={c.id} className="hcard"
            style={{ left: `calc(50% + ${Math.round((i - mid) * step)}px)`, "--rot": rot.toFixed(1) + "deg", "--dy": dy.toFixed(0) + "px", zIndex: i }}
            onDoubleClick={() => onPlay(c)}>
            <Card card={c} w={w} mine zone="hand" onMenu={onMenu} onHover={onHover} onTap={() => {}} big />
          </div>
        );
      })}
    </div>
  );
}

function OppHand({ count }) {
  const n = Math.min(count, 12);
  if (!n) return null;
  return (
    <div className="opphand">
      {Array.from({ length: n }, (_, i) => {
        const mid = (n - 1) / 2;
        const rot = n > 1 ? ((i - mid) / mid || 0) * -Math.min(10, n * 2) : 0;
        return <div key={i} className="oh card-back card-i" style={{ transform: `rotate(${180 + rot}deg) translateY(${Math.abs(i - mid) * 2}px)` }}><Pips size={3} /></div>;
      })}
    </div>
  );
}

/* ---------- piles compactes des rails ---------- */
function MiniPile({ label, count, topCard, back, onClick, onHover, onDropCard, title }) {
  const [over, setOver] = useState(false);
  return (
    <div className="mpile" title={title || ""}
      onDragOver={onDropCard ? (e) => { e.preventDefault(); setOver(true); } : undefined}
      onDragLeave={onDropCard ? () => setOver(false) : undefined}
      onDrop={onDropCard ? (e) => { e.preventDefault(); setOver(false); try { const d = JSON.parse(e.dataTransfer.getData("text/plain")); onDropCard(d.id, d.from); } catch (er) {} } : undefined}
    >
      <div className={"mp-c" + (over ? " drop-over" : "") + (back && count > 0 ? " card-back" : "")} onClick={onClick}
        onMouseEnter={() => onHover && topCard && !back && onHover(topCard)}
        onMouseLeave={() => onHover && onHover(null)}>
        {count > 0 && !back && topCard && (topCard.img ? <img src={topCard.img} alt="" /> : <div className="card-txt" style={{ fontSize: 7 }}>{dn(topCard)}</div>)}
        {count > 0 && back && <Pips size={3} />}
        {count === 0 && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)", fontSize: 11 }}>—</div>}
      </div>
      <div className="mp-n">{count}</div>
      <div className="mp-l">{label}</div>
    </div>
  );
}

function LifeOrb({ me, name, life, cmdDmg, onLife, onCmd, waiting }) {
  return (
    <div className="plaque">
      <div className="pname" style={{ color: me ? "var(--gold)" : "var(--ink)" }}>
        {name || <span className="wait">{t("en attente…")}</span>}
      </div>
      <div className={"orb" + (me ? " me" : "")}>
        {onLife && <button className="lbtn" style={{ position: "absolute", left: -30, top: "50%", transform: "translateY(-50%)" }} onClick={() => onLife(-1)}>−</button>}
        <div className={"n" + (life !== null && life <= 10 ? " low" : "")}>{life === null ? "—" : life}</div>
        {onLife && <button className="lbtn" style={{ position: "absolute", right: -30, top: "50%", transform: "translateY(-50%)" }} onClick={() => onLife(1)}>+</button>}
      </div>
      {onLife && (
        <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
          <button className="lbtn" style={{ fontSize: 9, width: 28 }} onClick={() => onLife(-5)}>−5</button>
          <button className="lbtn" style={{ fontSize: 9, width: 28 }} onClick={() => onLife(5)}>+5</button>
        </div>
      )}
      <div className="cmdmg hint" title={t("Dégâts de commandant reçus (21 = défaite)")}>
        {onCmd && <button className="lbtn" style={{ width: 20, height: 20, fontSize: 11 }} onClick={() => onCmd(-1)}>−</button>}
        <span>⚔ {t("cmdt")} <b style={{ color: (cmdDmg || 0) >= 21 ? "#e07b63" : "var(--ink)", fontSize: 13 }}>{cmdDmg || 0}</b>/21</span>
        {onCmd && <button className="lbtn" style={{ width: 20, height: 20, fontSize: 11 }} onClick={() => onCmd(1)}>+</button>}
      </div>
      {waiting && <div className="hint wait" style={{ textAlign: "center", marginTop: 6 }}>{waiting}</div>}
    </div>
  );
}

/* ---------- textes d'aide (HTML statique écrit par nous, donc sûr) ---------- */
const HELP_FR = [
  "✋ <b>Double-clic</b> sur une carte de votre main (l'éventail en bas) : la jouer. Elle se range automatiquement dans la bonne rangée (Terrains / Créatures / Autres).",
  "🖱 <b>Clic</b> sur une carte en jeu : l'engager / la dégager.",
  "⋮ <b>Bouton ⋮</b> (au survol) ou <b>clic droit</b> : toutes les actions (cimetière, exil, marqueurs, face cachée…).",
  "↔ <b>Placement libre</b> : posez et déplacez vos cartes où vous voulez sur votre zone (les bandes ne sont qu'un repère visuel). Le bouton 🧲 (rail droit) aligne automatiquement sur les bandes ; désactivez-le pour un placement totalement libre. Déposez sur les piles du rail gauche pour changer de zone.",
  "🫳 <b>Vol de cartes</b> : ⋮ (ou clic droit) sur une carte adverse → « Prendre le contrôle ». Cliquez la bibliothèque adverse pour y prendre une carte quand un effet le demande, idem cimetière/exil. « Rendre au propriétaire » depuis le menu de la carte volée.",
  "🔗 <b>Équiper / enchanter</b> : glissez une carte <i>directement sur</i> une autre — elles s'empilent. Ou bien ⋮ → « Attacher à… » puis cliquez la cible. ⋮ → « Détacher » pour séparer.",
  "📚 <b>Clic sur votre bibliothèque</b> (rail gauche) ou sur « Piocher » : piocher. « Regarder X » et « Chercher » pour fouiller. « Meuler X » envoie le dessus de la bibliothèque au cimetière.",
  "🏷 <b>Marqueurs nommés</b> : ⋮ sur une carte en jeu → « Marqueur nommé… » — appelez-le comme vous voulez (poison, provoc, indestructible…), puis +/− depuis le même menu.",
  "⛓ <b>Groupes</b> : « Créer un groupe » (rail droit) pose une carte-groupe colorée. ⋮ dessus → « Lier des cartes », puis cliquez les cartes concernées. Tout marqueur mis sur le groupe s'applique aussi à toutes ses cartes liées (pastille de couleur en haut des cartes).",
  "👁 <b>Survolez</b> n'importe quelle carte pour la lire en grand sur le côté gauche.",
  "🎲 Les dés, la pièce et chaque action sont inscrits dans le journal (rail droit), visible par les deux joueurs.",
  "🎙 <b>Vocal</b> : le bouton en haut à droite active un chat vocal pair-à-pair entre les joueurs du salon (autorisez le micro). Rien n'est enregistré ni ne transite par le serveur. Nécessite HTTPS.",
];
const HELP_EN = [
  "✋ <b>Double-click</b> a card in your hand (the fan at the bottom) to play it. It goes to the right row automatically (Lands / Creatures / Others).",
  "🖱 <b>Click</b> a card on the battlefield to tap / untap it.",
  "⋮ <b>⋮ button</b> (on hover) or <b>right-click</b>: every action (graveyard, exile, counters, face down…).",
  "↔ <b>Free placement</b>: put and move your cards anywhere in your area (the bands are just a visual guide). The 🧲 button (right rail) snaps cards to the bands; turn it off for fully free placement. Drop onto the left-rail piles to change zones.",
  "🫳 <b>Stealing cards</b>: ⋮ (or right-click) on an opponent's card → “Take control”. Click the opponent's library to take a card when an effect asks for it, same for graveyard/exile. “Return to owner” from the stolen card's menu.",
  "🔗 <b>Equip / enchant</b>: drag a card <i>directly onto</i> another — they stack. Or ⋮ → “Attach to…” then click the target. ⋮ → “Detach” to separate.",
  "📚 <b>Click your library</b> (left rail) or “Draw” to draw. “Look at X” and “Search” to dig. “Mill X” sends the top of your library to the graveyard.",
  "🏷 <b>Named counters</b>: ⋮ on a battlefield card → “Named counter…” — call it whatever you like (poison, stun, shield…), then +/− from the same menu.",
  "⛓ <b>Groups</b>: “Create a group” (right rail) drops a colored group card. ⋮ on it → “Link cards”, then click the cards. Any counter put on the group also applies to all its linked cards (colored dot on top of the cards).",
  "👁 <b>Hover</b> any card to read it full-size on the left side.",
  "🎲 Dice, coin flips and every action are written to the log (right rail), visible to all players.",
  "🎙 <b>Voice</b>: the button at the top right starts a peer-to-peer voice chat between the room's players (allow the microphone). Nothing is recorded and nothing goes through the server. Requires HTTPS.",
];

/* ---------- partie ---------- */
function Game({ room, onQuit, uiLang, onLang }) {
  const { code, seat, deck, pname } = room;
  const myKey = `mtgr-${code}-${seat}`, metaKey = `mtgr-${code}-meta`;

  const [my, setMy] = useState(null);
  const [opps, setOpps] = useState({}); // siège -> état du joueur
  const [oppIdx, setOppIdx] = useState(0); // adversaire affiché (flèches)
  const [meta, setMeta] = useState(null);
  const [menu, setMenu] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [topN, setTopN] = useState(null);
  const [hover, setHover] = useState(null);
  const [ask, setAsk] = useState(null);
  const [askVal, setAskVal] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [attachMode, setAttachMode] = useState(null); // id de la carte à attacher
  const [linkMode, setLinkMode] = useState(null); // id du groupe en cours de liaison
  const [snap, setSnap] = useState(true); // aimant d'alignement du placement libre
  const [copied, setCopied] = useState(false);
  const [oppLibMenu, setOppLibMenu] = useState(null); // { x, y } — actions sur la biblio adverse
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(code); }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = code; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e2) {}
      document.body.removeChild(ta);
    }
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };
  /* ---- chat vocal (WebRTC pair-à-pair, signalisation via le serveur KV) ---- */
  const [voice, setVoice] = useState(null); // null | { muted }
  const [voicePeers, setVoicePeers] = useState({}); // seat -> "connexion" | "ok"
  const pcsRef = useRef({});      // seat -> RTCPeerConnection
  const streamRef = useRef(null); // flux micro local
  const audiosRef = useRef({});   // seat -> élément <audio>
  const sigSeen = useRef({});     // seat -> id du dernier message de signalisation lu
  const voiceOn = useRef(false);
  const [artPick, setArtPick] = useState(null);
  const [tokenPick, setTokenPick] = useState(false);
  const [help, setHelp] = useState(false);
  const pushT = useRef(null);
  const first = useRef(true);
  const vh = useVH();
  const centerRef = useRef(null);
  const centerW = useWidth(centerRef, !!my);

  /* signale au CSS qu'une fenêtre de recherche est ouverte : l'aperçu en grand
     se colle alors au bord gauche pour ne pas recouvrir la fenêtre. */
  useEffect(() => {
    const open = !!(viewer || topN || tokenPick || artPick);
    document.body.classList.toggle("has-modal", open);
    return () => document.body.classList.remove("has-modal");
  }, [viewer, topN, tokenPick, artPick]);

  const freshState = () => {
    const { library, command } = buildInstances(deck);
    const hand = library.splice(0, 7);
    return { name: pname, seat, deckId: deck.id, life: 40, cmdDmg: 0, log: [{ t: Date.now(), who: pname, msg: t("rejoint la table et pioche 7 cartes") }],
      zones: { library, hand, battlefield: [], graveyard: [], exile: [], command } };
  };

  useEffect(() => { (async () => {
    const seen = await sget(`mtg-evtseen-${code}-${seat}`);
    evtSeen.current = parseInt(seen, 10) || 0;
    const prev = await sget(myKey, true);
    if (prev && prev.deckId === deck.id) setMy(prev); else { const f = freshState(); setMy(f); await sset(myKey, f, true); }
  })(); }, []);

  useEffect(() => {
    if (!my) return;
    if (first.current) { first.current = false; return; }
    clearTimeout(pushT.current);
    pushT.current = setTimeout(() => sset(myKey, { ...my, updatedAt: Date.now() }, true), 550);
    return () => clearTimeout(pushT.current);
  }, [my]);

  /* ---- transferts de cartes entre joueurs (vol / restitution) ----
     Chaque joueur a une file d'événements ; le destinataire l'applique à SON
     état (source de vérité), ce qui évite tout conflit de synchronisation. */
  const evtSeen = useRef(0);
  const hideIds = useRef(new Set()); // cartes volées : masquées chez l'adversaire jusqu'à traitement
  const mvPend = useRef({}); // id -> zone cible : déplacements adverses en attente de traitement
  const evtKey = (sx) => `mtgr-${code}-evt-${sx}`;
  const sendEvt = async (sx, evt) => {
    const arr = (await sget(evtKey(sx), true)) || [];
    const i = arr.length ? arr[arr.length - 1].i + 1 : 1;
    arr.push({ ...evt, i });
    await sset(evtKey(sx), arr.slice(-40), true);
  };
  const withLogPre = (st, msg) => msg ? { ...st, log: [...(st.log || []).slice(-30), { t: Date.now(), who: pname, msg }] } : st;
  const applyEvt = (st, ev) => {
    if (ev.k === "del") {
      const zones = { ...st.zones }; let found = null;
      for (const zn of Object.keys(zones)) {
        const i2 = zones[zn].findIndex((c) => c.id === ev.id);
        if (i2 >= 0) {
          const arr = [...zones[zn]]; const [c] = arr.splice(i2, 1); found = c;
          zones[zn] = arr.map((x) => (x.host === ev.id ? { ...x, host: null } : x));
          break;
        }
      }
      if (!found) return st;
      return withLogPre({ ...st, zones }, `${t("perd le contrôle de")} ${dn(found)}${ev.by ? ` (${ev.by})` : ""}`);
    }
    if (ev.k === "mv" && ev.id && ev.to) {
      const zones = { ...st.zones }; let found = null;
      for (const zn of Object.keys(zones)) {
        const i2 = zones[zn].findIndex((c) => c.id === ev.id);
        if (i2 >= 0) {
          const arr = [...zones[zn]]; const [c] = arr.splice(i2, 1);
          found = { ...c, faceDown: false, flipped: false, tapped: false, counters: 0, marks: null, groups: null, host: null, bx: null, by: null };
          zones[zn] = arr.map((x) => (x.host === ev.id ? { ...x, host: null } : x));
          break;
        }
      }
      if (!found || !zones[ev.to]) return st;
      zones[ev.to] = [...zones[ev.to], found];
      return withLogPre({ ...st, zones }, `${dn(found)} → ${t(ZLBL[ev.to])}${ev.by ? ` (${ev.by})` : ""}`);
    }
    if (ev.k === "add" && ev.card) {
      for (const zn of Object.keys(st.zones)) if (st.zones[zn].some((c) => c.id === ev.card.id)) return st;
      const zn = st.zones[ev.zone] ? ev.zone : "battlefield";
      const c = { ...ev.card, host: null, groups: null };
      return withLogPre({ ...st, zones: { ...st.zones, [zn]: [...st.zones[zn], c] } },
        `${t("récupère")} ${dn(c)}${ev.by ? ` (${t("rendue par")} ${ev.by})` : ""}`);
    }
    return st;
  };

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const m = await sget(metaKey, true);
      if (m && !m.order) m.order = Object.keys(m.names || {});
      if (m && !stop) setMeta(m);
      const next = {};
      const present = new Set(); // ids masqués encore présents chez un adversaire
      for (const sx of (m && m.order) || []) {
        if (sx === seat) continue;
        const o = await sget(`mtgr-${code}-${sx}`, true);
        if (!o) continue;
        if (hideIds.current.size && o.zones) {
          const zones = {};
          for (const zn of Object.keys(o.zones)) {
            zones[zn] = o.zones[zn].filter((c) => {
              if (hideIds.current.has(c.id)) { present.add(c.id); return false; }
              return true;
            });
          }
          o.zones = zones;
        }
        next[sx] = o;
      }
      /* ménage : dès que plus aucun adversaire ne contient l'id, on cesse de le masquer */
      for (const id of [...hideIds.current]) if (!present.has(id)) hideIds.current.delete(id);
      /* déplacements en attente (exil/meule du dessus) : on rejoue le déplacement
         localement tant que le propriétaire n'a pas traité l'événement */
      for (const sx of Object.keys(next)) {
        const o = next[sx];
        for (const id of Object.keys(mvPend.current)) {
          const to = mvPend.current[id];
          for (const zn of Object.keys(o.zones)) {
            const i3 = o.zones[zn].findIndex((c) => c.id === id);
            if (i3 < 0) continue;
            if (zn === to) delete mvPend.current[id];
            else {
              const arr = [...o.zones[zn]]; const [c] = arr.splice(i3, 1);
              o.zones = { ...o.zones, [zn]: arr, [to]: [...o.zones[to], { ...c, faceDown: false }] };
            }
            break;
          }
        }
      }
      if (!stop) setOpps(next);
      /* événements qui me sont adressés (vol / restitution) */
      try {
        const evts = (await sget(evtKey(seat), true)) || [];
        const fresh = evts.filter((ev) => ev.i > evtSeen.current);
        if (fresh.length && !stop) {
          evtSeen.current = evts[evts.length - 1].i;
          sset(`mtg-evtseen-${code}-${seat}`, String(evtSeen.current));
          setMy((st) => {
            if (!st) return st;
            let out = st;
            for (const ev of fresh) out = applyEvt(out, ev);
            return out;
          });
        }
      } catch (e) {}
    };
    tick();
    const iv = setInterval(tick, 2500);
    return () => { stop = true; clearInterval(iv); };
  }, [code]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { setAttachMode(null); setLinkMode(null); setMenu(null); setOppLibMenu(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mergedLog = useMemo(() => {
    if (!my) return [];
    const all = [...(my.log || [])];
    for (const sx of Object.keys(opps)) all.push(...(opps[sx].log || []));
    return all.sort((a, b) => b.t - a.t).slice(0, 40);
  }, [my, opps]);

  /* battement de cœur du vocal : présence, (re)connexions, signalisation */
  useEffect(() => {
    if (!voice) return;
    let stop = false;
    const beat = async () => {
      if (stop || !voiceOn.current) return;
      await sset(voipKey(seat), { on: true, t: Date.now() }, true);
      const ord = (meta && meta.order) || [];
      const myIdx = ord.indexOf(seat);
      for (const sx of ord) {
        if (sx === seat || stop) continue;
        const pres = await sget(voipKey(sx), true);
        const active = pres && pres.on && Date.now() - pres.t < 15000;
        if (!active) { if (pcsRef.current[sx]) closePC(sx); continue; }
        // l'initiateur est celui qui vient en premier dans l'ordre des sièges
        if (!pcsRef.current[sx] && myIdx < ord.indexOf(sx)) {
          const pc = createPC(sx);
          try {
            const of = await pc.createOffer();
            await pc.setLocalDescription(of);
            await waitIce(pc);
            await sendSig(sx, "offer", pc.localDescription);
          } catch (e) { closePC(sx); }
        }
        // messages entrants de ce joueur
        const inbox = (await sget(sigKey(sx, seat), true)) || [];
        for (const m of inbox) {
          if (m.i <= (sigSeen.current[sx] || 0)) continue;
          sigSeen.current[sx] = m.i;
          try {
            if (m.kind === "offer") {
              if (pcsRef.current[sx]) closePC(sx); // nouvelle session
              const pc = createPC(sx);
              await pc.setRemoteDescription(m.sdp);
              const an = await pc.createAnswer();
              await pc.setLocalDescription(an);
              await waitIce(pc);
              await sendSig(sx, "answer", pc.localDescription);
            } else if (m.kind === "answer") {
              const pc = pcsRef.current[sx];
              if (pc && !pc.currentRemoteDescription) await pc.setRemoteDescription(m.sdp);
            }
          } catch (e) { console.warn("vocal:", e); }
        }
      }
    };
    beat();
    const iv = setInterval(beat, 2500);
    return () => { stop = true; clearInterval(iv); };
  }, [voice, meta, code, seat]);

  /* quitter proprement le vocal quand on quitte la partie.
     N'utilise que des refs : ce hook est déclaré avant le retour anticipé
     "Préparation de la table…", où les fonctions du jeu n'existent pas encore. */
  useEffect(() => () => {
    voiceOn.current = false;
    for (const sx of Object.keys(pcsRef.current)) { try { pcsRef.current[sx].close(); } catch (e) {} }
    pcsRef.current = {};
    if (streamRef.current) { for (const tk of streamRef.current.getTracks()) tk.stop(); streamRef.current = null; }
    document.body.classList.remove("dragging");
  }, []);

  if (!my) return <div style={{ margin: "auto" }} className="wait disp">{t("Préparation de la table…")}</div>;

  const withLog = (s, msg) => msg ? { ...s, log: [...(s.log || []).slice(-30), { t: Date.now(), who: pname, msg }] } : s;
  const addLog = (msg) => setMy((s) => withLog(s, msg));

  const move = (id, from, to, opt = {}) => {
    if (from === to && to !== "library") return;
    setMy((s) => {
      const zones = { ...s.zones }; const src = [...zones[from]];
      const i = src.findIndex((c) => c.id === id); if (i < 0) return s;
      const [c0] = src.splice(i, 1); const card = { ...c0 };
      const shown = card.faceDown && from !== "hand" ? t("une carte face cachée") : dn(card);
      if (to !== "battlefield") { card.tapped = false; card.faceDown = false; card.flipped = false; card.counters = 0; card.marks = null; card.groups = null; card.bx = null; card.by = null; }
      card.host = null;
      if (to === "battlefield") {
        card.row = opt.row || card.row || card.t || "other";
        const bandY = BANDS[card.row] || 0.5;
        card.by = opt.by != null ? opt.by : bandY;
        if (opt.bx != null) card.bx = opt.bx;
        else {
          const near = zones.battlefield.filter((c) => !c.host && Math.abs((c.by != null ? c.by : (BANDS[c.row || c.t || "other"] || 0.5)) - bandY) < 0.15).length;
          card.bx = Math.min(0.94, 0.065 + near * 0.088);
        }
      }
      if (opt.faceDown) card.faceDown = true;
      zones[from] = src;
      if (from === "battlefield") zones.battlefield = zones.battlefield.map((c) => c.host === id ? { ...c, host: null } : c);
      if (from === "battlefield" && c0.grp && to !== "battlefield")
        zones.battlefield = zones.battlefield.map((c) => {
          if (!c.groups || !c.groups[id]) return c;
          const groups = { ...c.groups }; delete groups[id];
          return { ...c, groups };
        });
      if (card.token && to !== "battlefield") return withLog({ ...s, zones }, `${t("supprime le jeton")} ${dn(card)}`);
      const dst = [...zones[to]];
      if (to === "library") { opt.bottom ? dst.push(card) : dst.unshift(card); }
      else dst.push(card);
      zones[to] = dst;
      let msg;
      if (from === "hand" && to === "battlefield") msg = opt.faceDown ? t("joue une carte face cachée") : `${t("joue")} ${dn(card)}`;
      else if (from === "command" && to === "battlefield") msg = `${t("lance son commandant")} ${dn(card)} ⭐`;
      else if (to === "graveyard") msg = from === "hand" ? `${t("se défausse de")} ${dn(card)}` : `${t("met")} ${shown} ${t("au cimetière")}`;
      else if (to === "exile") msg = `${t("exile")} ${shown}`;
      else if (to === "command") msg = `${t("renvoie")} ${dn(card)} ${t("en zone de commandement")}`;
      else if (to === "hand") msg = from === "library" ? t("pioche une carte") : `${t("reprend")} ${shown} ${t("en main")}`;
      else if (to === "library") msg = `${t("remet une carte")} ${opt.bottom ? t("sous la bibliothèque") : t("sur la bibliothèque")}`;
      else if (to === "battlefield") msg = `${t("met")} ${shown} ${t("sur le champ de bataille")}`;
      return withLog({ ...s, zones }, msg);
    });
  };

  const setRow = (id, row) => setMy((s) => ({ ...s, zones: { ...s.zones, battlefield: s.zones.battlefield.map((c) => c.id === id ? { ...c, row, host: null, by: BANDS[row] || 0.5 } : c.host === id ? { ...c, row } : c) } }));
  const stealFromOpp = (card, fromZone, toZone) => {
    if (!curOppSeat) return;
    /* 1) tout le visuel change dans le même rendu : la carte ne peut pas
       exister aux deux endroits, même une milliseconde */
    hideIds.current.add(card.id);
    setOpps((o) => {
      const st = o[curOppSeat]; if (!st) return o;
      return { ...o, [curOppSeat]: { ...st, zones: { ...st.zones, [fromZone]: st.zones[fromZone].filter((c) => c.id !== card.id) } } };
    });
    const c = { ...card, host: null, groups: null, tapped: false, bx: null, by: null,
      ownerSeat: card.ownerSeat || curOppSeat, ownerName: card.ownerName || oppName || curOppSeat };
    if (toZone !== "battlefield") { c.faceDown = false; c.flipped = false; c.counters = 0; c.marks = null; }
    setMy((s) => {
      const dst = [...s.zones[toZone]]; dst.push(c);
      const msg = fromZone === "battlefield"
        ? `${t("prend le contrôle de")} ${dn(card)}`
        : `${t("prend")} ${dn(card)} (${t(ZLBL[fromZone])} ${t("de")} ${oppName || curOppSeat})`;
      return withLog({ ...s, zones: { ...s.zones, [toZone]: dst } }, msg);
    });
    /* 2) puis on prévient le propriétaire (réseau) */
    sendEvt(curOppSeat, { k: "del", id: card.id, by: pname });
  };
  /* dessus de la bibliothèque adverse : actions à l'aveugle (effets qui le demandent) */
  const oppTopTo = (to) => {
    if (!opp || !curOppSeat) return;
    const top = opp.zones.library[0]; if (!top) return;
    const card = { ...top, faceDown: false };
    setOpps((o) => {
      const st = o[curOppSeat]; if (!st) return o;
      return { ...o, [curOppSeat]: { ...st, zones: { ...st.zones,
        library: st.zones.library.filter((c) => c.id !== top.id), [to]: [...st.zones[to], card] } } };
    });
    mvPend.current[top.id] = to;
    addLog(`${to === "exile" ? t("exile") : t("meule")} ${t("la carte du dessus de")} ${oppName || curOppSeat} : ${dn(top)}`);
    sendEvt(curOppSeat, { k: "mv", id: top.id, to, by: pname });
  };
  const stealOppTop = (toZone) => {
    if (!opp) return;
    const top = opp.zones.library[0]; if (!top) return;
    stealFromOpp(top, "library", toZone);
  };

  const returnToOwner = async (card) => {
    const owner = card.ownerSeat; if (!owner) return;
    setMy((s) => {
      const zones = { ...s.zones };
      for (const zn of Object.keys(zones)) zones[zn] = zones[zn].filter((c) => c.id !== card.id).map((x) => (x.host === card.id ? { ...x, host: null } : x));
      return withLog({ ...s, zones }, `${t("rend")} ${dn(card)} ${t("à")} ${card.ownerName || owner}`);
    });
    const clean = { ...card, host: null, groups: null, bx: null, by: null, tapped: false, ownerSeat: null, ownerName: null };
    await sendEvt(owner, { k: "add", zone: "battlefield", card: clean, by: pname });
  };

  const placeAt = (id, from, nx, ny) => {
    if (from === "battlefield") setMy((s) => {
      const bf = [...s.zones.battlefield];
      const i = bf.findIndex((c) => c.id === id); if (i < 0) return s;
      const [c] = bf.splice(i, 1);
      bf.push({ ...c, bx: nx, by: ny, host: null }); // en fin de liste = au-dessus
      return { ...s, zones: { ...s.zones, battlefield: bf } };
    });
    else move(id, from, "battlefield", { bx: nx, by: ny });
  };

  const doAttach = (target, d) => {
    setMy((s) => {
      const bf = s.zones.battlefield;
      const find = (cid) => bf.find((c) => c.id === cid);
      let root = find(target.id) || target;
      let guard = 0;
      while (root.host && guard++ < 20) { const p = find(root.host); if (!p) break; root = p; }
      if (root.id === d.id) return s;
      if (d.from === "battlefield") {
        const card = find(d.id); if (!card) return s;
        const zones = { ...s.zones, battlefield: bf.map((c) => c.id === d.id ? { ...c, host: root.id, row: root.row } : c.host === d.id ? { ...c, host: root.id, row: root.row } : c) };
        return withLog({ ...s, zones }, `${t("attache")} ${dn(card)} ${t("à")} ${dn(root)}`);
      } else {
        const src = [...s.zones[d.from]]; const i = src.findIndex((c) => c.id === d.id); if (i < 0) return s;
        const [c0] = src.splice(i, 1);
        const card = { ...c0, tapped: false, faceDown: false, host: root.id, row: root.row };
        const zones = { ...s.zones, [d.from]: src, battlefield: [...bf, card] };
        return withLog({ ...s, zones }, `${t("joue")} ${dn(card)}, ${t("attachée à")} ${dn(root)}`);
      }
    });
  };
  const detach = (id) => setMy((s) => {
    const card = s.zones.battlefield.find((c) => c.id === id);
    return withLog({ ...s, zones: { ...s.zones, battlefield: s.zones.battlefield.map((c) => c.id === id ? { ...c, host: null } : c) } }, card ? `${t("détache")} ${dn(card)}` : null);
  });

  const draw = (n = 1) => setMy((s) => {
    const lib = [...s.zones.library]; const take = lib.splice(0, n);
    if (!take.length) return withLog(s, t("essaie de piocher… bibliothèque vide !"));
    return withLog({ ...s, zones: { ...s.zones, library: lib, hand: [...s.zones.hand, ...take.map((c) => ({ ...c }))] } },
      n === 1 ? t("pioche une carte") : `${t("pioche")} ${take.length} ${t("cartes")}`);
  });
  const doShuffle = () => setMy((s) => withLog({ ...s, zones: { ...s.zones, library: shuffleArr(s.zones.library) } }, t("mélange sa bibliothèque")));
  const untapAll = () => setMy((s) => withLog({ ...s, zones: { ...s.zones, battlefield: s.zones.battlefield.map((c) => ({ ...c, tapped: false })) } }, t("dégage tout")));
  const mulligan = (n = 7) => setMy((s) => {
    const lib = shuffleArr([...s.zones.library, ...s.zones.hand.map((c) => ({ ...c, faceDown: false, tapped: false }))]);
    const hand = lib.splice(0, Math.max(0, Math.min(n, lib.length)));
    return withLog({ ...s, zones: { ...s.zones, library: lib, hand } },
      `${t("fait un mulligan : main mélangée dans la bibliothèque, re-pioche")} ${hand.length} ${hand.length > 1 ? t("cartes") : t("carte")}`);
  });
  const mill = (n) => setMy((s) => {
    const lib = [...s.zones.library];
    const take = lib.splice(0, n).map((c) => ({ ...c, faceDown: false, tapped: false }));
    if (!take.length) return withLog(s, t("essaie de meuler… bibliothèque vide !"));
    const names = take.length <= 5 ? " : " + take.map(dn).join(", ") : "";
    return withLog({ ...s, zones: { ...s.zones, library: lib, graveyard: [...s.zones.graveyard, ...take] } },
      `${t("meule")} ${take.length} ${take.length > 1 ? t("cartes") : t("carte")}${names}`);
  });
  const bumpMark = (id, name, d) => setMy((s) => {
    const target = s.zones.battlefield.find((c) => c.id === id); if (!target) return s;
    const ids = new Set([id]);
    if (target.grp) for (const c of s.zones.battlefield) if (c.groups && c.groups[id]) ids.add(c.id);
    const bf = s.zones.battlefield.map((c) => {
      if (!ids.has(c.id)) return c;
      const marks = { ...(c.marks || {}) };
      const v = (marks[name] || 0) + d;
      if (v <= 0) delete marks[name]; else marks[name] = v;
      return { ...c, marks };
    });
    const extra = target.grp && ids.size > 1 ? ` ${t("et")} ${ids.size - 1} ${ids.size > 2 ? t("cartes liées") : t("carte liée")}` : "";
    const msg = d > 0 ? `${t("ajoute un marqueur")} « ${name} » ${t("sur")} ${dn(target)}${extra}` : `${t("retire un marqueur")} « ${name} » ${t("de la carte")} ${dn(target)}${extra}`;
    return withLog({ ...s, zones: { ...s.zones, battlefield: bf } }, msg);
  });
  const submitAsk = () => {
    const a = ask, v = String(askVal).trim();
    setAsk(null);
    if (!a) return;
    if (a.type === "look") { const n = parseInt(v, 10); if (n > 0) { setTopN(n); addLog(`${t("regarde les")} ${n} ${t("cartes du dessus")}`); } }
    else if (a.type === "mill") { const n = parseInt(v, 10); if (n > 0) mill(n); }
    else if (a.type === "mull") { const n = parseInt(v, 10); if (n > 0) mulligan(n); }
    else if (a.type === "mark" && v) bumpMark(a.cardId, v, 1);
    else if (a.type === "group" && v) spawnGroup(v);
  };
  const tapToggle = (card) => setMy((s) => withLog({ ...s, zones: { ...s.zones, battlefield: s.zones.battlefield.map((c) => c.id === card.id ? { ...c, tapped: !c.tapped } : c) } },
    `${card.tapped ? t("dégage") : t("engage")} ${card.faceDown ? t("une carte") : dn(card)}`));
  const onBFTap = (card) => {
    if (linkMode) { if (card.id === linkMode) setLinkMode(null); else toggleLink(linkMode, card); return; }
    if (attachMode) { if (card.id !== attachMode) doAttach(card, { id: attachMode, from: "battlefield" }); setAttachMode(null); return; }
    tapToggle(card);
  };
  const bump = (id, d) => setMy((s) => {
    const target = s.zones.battlefield.find((c) => c.id === id); if (!target) return s;
    const ids = new Set([id]);
    if (target.grp) for (const c of s.zones.battlefield) if (c.groups && c.groups[id]) ids.add(c.id);
    return { ...s, zones: { ...s.zones, battlefield: s.zones.battlefield.map((c) => ids.has(c.id) ? { ...c, counters: Math.max(0, c.counters + d) } : c) } };
  });
  const flip = (id) => setMy((s) => ({ ...s, zones: { ...s.zones, battlefield: s.zones.battlefield.map((c) => c.id === id ? { ...c, faceDown: !c.faceDown } : c) } }));
  /* Transformer une carte recto-verso : on bascule la face visible. Le type de la
     face affichée (ft/bt) devient le type courant, pour rester cohérent si on
     range la carte par rangée. La position et les marqueurs sont préservés. */
  const transform = (id) => setMy((s) => {
    const card = s.zones.battlefield.find((c) => c.id === id);
    if (!card || !card.dfc) return s;
    const flipped = !card.flipped;
    const nt = (flipped ? card.bt : card.ft) || card.t;
    const bf = { ...card, flipped, t: nt };
    const shown = flipped ? (card.bfn || card.bname || card.name) : (card.fn || card.name);
    return withLog({ ...s, zones: { ...s.zones, battlefield: s.zones.battlefield.map((c) => c.id === id ? bf : c) } },
      `${t("transforme")} ${dn(card)} → ${shown}`);
  });
  const clone = (card) => setMy((s) => withLog({ ...s, zones: { ...s.zones, battlefield: [...s.zones.battlefield, { ...card, id: uid(), token: true, tapped: false, host: null }] } }, `${t("crée une copie-jeton de")} ${dn(card)}`));

  const applyArt = (card, p, all) => {
    const key = card.name.toLowerCase();
    const im = deck.imgs[key] || {};
    /* On applique aussi la face arrière de l'impression choisie : sans ça, une
       carte recto-verso perdrait son verso en changeant d'illustration. */
    const v = p ? { img: p.s, imgN: p.n, fn: p.fn || null,
                    ...(p.bs ? { dfc: true, bimg: p.bs, bimgN: p.bn || null, bfn: p.bfn || null }
                             : { dfc: false, flipped: false, bimg: null, bimgN: null, bfn: null }) }
      : { img: im.frs || im.s || null, imgN: im.frn || im.n || null, fn: im.fr || null,
          ...((im.bs || im.frbs) ? { dfc: true, bimg: im.frbs || im.bs, bimgN: im.frbn || im.bn, bfn: im.frb || null }
                                 : { dfc: false, flipped: false, bimg: null, bimgN: null, bfn: null }) };
    setMy((s) => {
      const zones = {};
      for (const zn of Object.keys(s.zones))
        zones[zn] = s.zones[zn].map((c) => (c.id === card.id || (all && c.name === card.name)) ? { ...c, ...v } : c);
      return withLog({ ...s, zones }, p ? `${t("choisit une illustration")} ${p.set} ${t("pour")} ${dn(card)}` : `${t("rétablit l'illustration de")} ${dn(card)}`);
    });
    if (all && !card.token) { // mémorisation dans le deck enregistré
      const arts = { ...(deck.arts || {}) };
      if (p) arts[key] = { s: p.s, n: p.n, fn: p.fn || null, set: p.set,
                           ...(p.bs ? { bs: p.bs, bn: p.bn || null, bfn: p.bfn || null } : {}) };
      else delete arts[key];
      deck.arts = arts;
      sget("mtg-decks").then((list) => { if (list) sset("mtg-decks", list.map((d) => d.id === deck.id ? { ...d, arts } : d)); });
    }
  };

  const spawnToken = (tk) => setMy((s) => withLog({ ...s, zones: { ...s.zones, battlefield: [...s.zones.battlefield, { id: uid(), name: tk.name, fn: tk.fn || null, img: tk.s || null, imgN: tk.n || null, pt: tk.pt || null, t: tk.t || "creature", row: tk.t || "creature", host: null, tapped: false, faceDown: false, counters: 0, token: true }] } }, `${t("crée un jeton")} ${tk.fn || tk.name}${tk.pt ? " " + tk.pt : ""}`));

  const spawnGroup = (name) => setMy((s) => {
    const used = s.zones.battlefield.filter((c) => c.grp).length;
    const color = GROUP_COLORS[used % GROUP_COLORS.length];
    return withLog({ ...s, zones: { ...s.zones, battlefield: [...s.zones.battlefield, { id: uid(), name, grp: true, color, t: "other", row: "other", host: null, tapped: false, faceDown: false, counters: 0, token: true }] } },
      `${t("crée le groupe")} « ${name} »`);
  });
  const toggleLink = (groupId, card) => setMy((s) => {
    const g = s.zones.battlefield.find((c) => c.id === groupId);
    if (!g || card.id === groupId || card.grp) return s;
    const cur = s.zones.battlefield.find((c) => c.id === card.id);
    if (!cur) return s;
    const adding = !(cur.groups && cur.groups[groupId]);
    const bf = s.zones.battlefield.map((c) => {
      if (c.id !== card.id) return c;
      const groups = { ...(c.groups || {}) };
      if (adding) groups[groupId] = g.color; else delete groups[groupId];
      return { ...c, groups };
    });
    return withLog({ ...s, zones: { ...s.zones, battlefield: bf } },
      adding ? `${t("lie")} ${dn(card)} ${t("au groupe")} « ${dn(g)} »` : `${t("délie")} ${dn(card)} ${t("du groupe")} « ${dn(g)} »`);
  });

  const removeCard = (card, zone) => setMy((s) => withLog({ ...s, zones: { ...s.zones,
    [zone]: s.zones[zone].filter((c) => c.id !== card.id).map((c) => {
      let out = c;
      if (out.host === card.id) out = { ...out, host: null };
      if (card.grp && out.groups && out.groups[card.id]) { const groups = { ...out.groups }; delete groups[card.id]; out = { ...out, groups }; }
      return out;
    }) } },
    card.grp ? `${t("supprime le groupe")} « ${dn(card)} »` : `${t("supprime le jeton")} ${dn(card)}`));

  const roll = (d) => addLog(d === 2 ? `${t("lance une pièce :")} ${Math.random() < .5 ? t("PILE") : t("FACE")}` : `${t("lance un")} d${d} : ${1 + Math.floor(Math.random() * d)} 🎲`);

  /* ================= chat vocal ================= */
  const voipKey = (sx) => `mtgr-${code}-voip-${sx}`;
  const sigKey = (from, to) => `mtgr-${code}-sig-${from}-${to}`;

  const sendSig = async (to, kind, sdp) => {
    const arr = (await sget(sigKey(seat, to), true)) || [];
    const i = arr.length ? arr[arr.length - 1].i + 1 : 1;
    arr.push({ i, kind, sdp });
    await sset(sigKey(seat, to), arr.slice(-30), true);
  };
  const waitIce = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, 3000); // au pire, on envoie ce qu'on a
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    });
  });
  const closePC = (sx) => {
    const pc = pcsRef.current[sx];
    if (pc) { try { pc.close(); } catch (e) {} delete pcsRef.current[sx]; }
    const a = audiosRef.current[sx];
    if (a) { try { a.srcObject = null; } catch (e) {} delete audiosRef.current[sx]; }
    setVoicePeers((p) => { const q = { ...p }; delete q[sx]; return q; });
  };
  const createPC = (sx) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcsRef.current[sx] = pc;
    setVoicePeers((p) => ({ ...p, [sx]: "connexion" }));
    if (streamRef.current) for (const t of streamRef.current.getTracks()) pc.addTrack(t, streamRef.current);
    pc.ontrack = (ev) => {
      let a = audiosRef.current[sx];
      if (!a) { a = new Audio(); a.autoplay = true; audiosRef.current[sx] = a; }
      a.srcObject = ev.streams[0];
      a.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setVoicePeers((p) => ({ ...p, [sx]: "ok" }));
      if (["failed", "closed"].includes(pc.connectionState)) closePC(sx); // sera retentée au prochain battement
    };
    return pc;
  };

  const joinVoice = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert(t("Micro indisponible. Le chat vocal nécessite HTTPS (ou localhost).")); return;
    }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = st; voiceOn.current = true;
      setVoice({ muted: false });
      await sset(voipKey(seat), { on: true, t: Date.now() }, true);
      addLog(t("rejoint le vocal 🎙"));
    } catch (e) {
      alert(t("Accès au micro refusé ou impossible : ") + (e && e.message ? e.message : e));
    }
  };
  const leaveVoice = async () => {
    voiceOn.current = false;
    for (const sx of Object.keys(pcsRef.current)) closePC(sx);
    if (streamRef.current) { for (const t of streamRef.current.getTracks()) t.stop(); streamRef.current = null; }
    setVoice(null); setVoicePeers({});
    await sset(voipKey(seat), { on: false, t: Date.now() }, true);
    addLog(t("quitte le vocal"));
  };
  const toggleMute = () => {
    const st = streamRef.current; if (!st) return;
    setVoice((v) => {
      const muted = !(v && v.muted);
      for (const t of st.getAudioTracks()) t.enabled = !muted;
      return v && { ...v, muted };
    });
  };


  const endTurn = async () => {
    if (!meta) return;
    const ord = meta.order || Object.keys(meta.names || { P1: 1 });
    const cur = Math.max(0, ord.indexOf(meta.turn));
    let nxt = meta.turn;
    for (let k = 1; k <= ord.length; k++) { // prochain joueur encore en vie
      const cand = ord[(cur + k) % ord.length];
      const st = cand === seat ? my : opps[cand];
      if (!st || st.life > 0) { nxt = cand; break; }
    }
    const m = { ...meta, turn: nxt, turnNo: (meta.turnNo || 1) + (ord.indexOf(nxt) <= cur ? 1 : 0) };
    setMeta(m); await sset(metaKey, m, true); addLog(t("termine son tour"));
  };
  const setLife = (d) => setMy((s) => ({ ...s, life: s.life + d }));
  const setCmdDmg = (d) => setMy((s) => ({ ...s, cmdDmg: Math.max(0, (s.cmdDmg || 0) + d) }));

  const openMenu = (e, card, zone) => setMenu({ x: e.clientX, y: e.clientY, card, zone });
  const closeMenu = () => { setMenu(null); setOppLibMenu(null); };

  const myTurn = meta && meta.turn === seat;
  const z = my.zones;
  const order = (meta && meta.order) || ["P1", "P2"];
  const oppSeats = order.filter((sx) => sx !== seat);
  const curOppSeat = oppSeats.length ? oppSeats[((oppIdx % oppSeats.length) + oppSeats.length) % oppSeats.length] : null;
  const opp = (curOppSeat && opps[curOppSeat]) || null;
  const oppName = (opp && opp.name) || (meta && meta.names && curOppSeat && meta.names[curOppSeat]) || null;
  const lifeOf = (sx) => { const st = sx === seat ? my : opps[sx]; return st ? st.life : null; };
  const aliveCount = order.filter((sx) => { const l = lifeOf(sx); return l === null || l > 0; }).length;
  const turnName = meta && meta.names ? meta.names[meta.turn] : null;

  /* hauteurs des rangées, calculées depuis la hauteur d'écran : tout tient sans défilement */
  const myAreaH = Math.round(vh * 0.336);
  /* la zone adverse occupe TOUT l'espace restant jusqu'à la ligne médiane
     (plus de vide entre les deux rangées de créatures) */
  const oppAreaH = Math.max(130, vh - 42 - 22 - myAreaH - Math.round(vh * 0.135) - 10);
  const cardHref = Math.round(vh * 0.104); // même taille de carte des deux côtés
  const rowW = Math.max(0, centerW - 12);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: vh, overflow: "hidden", position: "relative", zIndex: 1 }} onClick={closeMenu}>
      {/* ===== barre du haut ===== */}
      <div className="topbar">
        <span className="disp" style={{ color: "var(--gold)", fontSize: 13 }}>Table Commander</span>
        <button className="btn ghost codebtn" title={t("Copier le code")} onClick={copyCode}>
          {t("Salon")} <b style={{ letterSpacing: ".28em", color: "var(--ink)" }}>{code}</b> {copied ? <span style={{ color: "var(--green, #4f9e6b)" }}>✓ {t("copié !")}</span> : "⧉"}
        </button>
        <div className="pchips">
          {order.map((sx) => {
            const st = sx === seat ? my : opps[sx];
            const nm = (st && st.name) || (meta && meta.names && meta.names[sx]) || sx;
            const dead = st ? st.life <= 0 : false;
            return (
              <button key={sx}
                className={"pchip" + (dead ? " dead" : "") + (meta && meta.turn === sx ? " turn" : "") + (sx === seat ? " isme" : "") + (sx === curOppSeat ? " shown" : "")}
                title={sx === seat ? "Vous" : (dead ? nm + " est éliminé·e" : "Afficher le plateau de " + nm)}
                onClick={(e) => { e.stopPropagation(); if (sx !== seat) setOppIdx(Math.max(0, oppSeats.indexOf(sx))); }}>
                {dead ? "💀" : "❤"} {nm} · {st ? st.life : "…"}
              </button>
            );
          })}
          <span className="alivecount" title={t("Joueurs avec plus de 0 point de vie")}>⚔ {aliveCount}/{order.length} en vie</span>
        </div>
        <div style={{ flex: 1 }} />
        {!voice ? (
          <button className="btn ghost" title={t("Rejoindre le chat vocal (pair-à-pair)")} onClick={joinVoice}>{t("🎙 Vocal")}</button>
        ) : (
          <>
            <span className="hint" title={t("Joueurs connectés au vocal avec vous")}>
              🎙 {Object.values(voicePeers).filter((v) => v === "ok").length} {Object.values(voicePeers).filter((v) => v === "ok").length > 1 ? t("connectés") : t("connecté")}
              {Object.values(voicePeers).some((v) => v === "connexion") ? t(" · connexion…") : ""}
            </span>
            <button className={"btn ghost" + (voice.muted ? " danger" : "")} onClick={toggleMute}>{voice.muted ? t("🔇 Muet") : t("🎙 Micro on")}</button>
            <button className="btn ghost" onClick={leaveVoice}>{t("✕ Vocal")}</button>
          </>
        )}
        {DONATION_URL && <a className="btn ghost donbtn" href={DONATION_URL} target="_blank" rel="noopener noreferrer" title={t("Soutenir le développement")}>{t("❤ Don")}</a>}
        <button className="btn ghost" title="Langue / Language" onClick={() => onLang(uiLang === "fr" ? "en" : "fr")}>🌐 {uiLang === "fr" ? "EN" : "FR"}</button>
        <button className="btn ghost" onClick={() => setHelp(true)}>{t("? Aide")}</button>
        <button className="btn ghost danger" onClick={() => { if (confirmReset) { const f = freshState(); setMy(f); setConfirmReset(false); } else { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 3000); } }}>{confirmReset ? t("Confirmer le reset ?") : "↺ Reset"}</button>
        <button className="btn ghost" onClick={onQuit}>{t("Quitter")}</button>
      </div>

      {/* ===== bandeau mode attacher ===== */}
      {attachMode && (
        <div className="banner">
          🔗 {t("Cliquez sur la carte cible pour attacher")} <b>{dn(z.battlefield.find((c) => c.id === attachMode) || {})}</b>
          <button className="btn ghost" onClick={() => setAttachMode(null)}>{t("Annuler (Échap)")}</button>
        </div>
      )}
      {linkMode && (
        <div className="banner">
          ⛓ {t("Cliquez sur des cartes pour les lier / délier du groupe")} <b style={{ color: (z.battlefield.find((c) => c.id === linkMode) || {}).color || "var(--gold)" }}>{dn(z.battlefield.find((c) => c.id === linkMode) || {})}</b>
          <button className="btn gold" onClick={() => setLinkMode(null)}>{t("Terminer (Échap)")}</button>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* ===== rail gauche : joueurs & piles ===== */}
        <div className="rail left">
          {oppSeats.length > 1 && (
            <div className="oppnav">
              <button className="btn ghost" title={t("Adversaire précédent")} onClick={() => setOppIdx((i) => i - 1)}>◀</button>
              <span className="hint" style={{ fontWeight: 700 }}>{oppSeats.indexOf(curOppSeat) + 1}/{oppSeats.length}</span>
              <button className="btn ghost" title={t("Adversaire suivant")} onClick={() => setOppIdx((i) => i + 1)}>▶</button>
            </div>
          )}
          <LifeOrb me={false} name={oppName} life={opp ? opp.life : null} cmdDmg={opp ? opp.cmdDmg : 0}
            waiting={!opp ? `${t("partagez le code")} ${code}` : null} />
          <div className="mpiles">
            <MiniPile label={t("Biblio")} back count={opp ? opp.zones.library.length : 0}
              title={t("Bibliothèque adverse : actions (effets qui le demandent)")}
              onClick={(e) => { if (!opp) return; e.stopPropagation(); setOppLibMenu({ x: e.clientX, y: e.clientY }); }} />
            <MiniPile label={t("Main")} back count={opp ? opp.zones.hand.length : 0} />
            <MiniPile label={t("Cim.")} count={opp ? opp.zones.graveyard.length : 0} topCard={opp && opp.zones.graveyard[opp.zones.graveyard.length - 1]}
              onClick={() => opp && setViewer({ who: "opp", zone: "graveyard" })} onHover={setHover} />
            <MiniPile label={t("Exil")} count={opp ? opp.zones.exile.length : 0} topCard={opp && opp.zones.exile[opp.zones.exile.length - 1]}
              onClick={() => opp && setViewer({ who: "opp", zone: "exile" })} onHover={setHover} />
            <MiniPile label={t("Cmdt")} count={opp ? opp.zones.command.length : 0} topCard={opp && opp.zones.command[0]} onHover={setHover} />
          </div>

          <div style={{ flex: 1 }} />

          <div className="mpiles" style={{ marginBottom: 10 }}>
            <MiniPile label={t("Biblio")} back count={z.library.length} onClick={() => draw(1)}
              onDropCard={(id, from) => move(id, from, "library")} title={t("Clic : piocher · Déposez une carte : dessus de la bibliothèque")} />
            <MiniPile label={t("Cim.")} count={z.graveyard.length} topCard={z.graveyard[z.graveyard.length - 1]}
              onClick={() => setViewer({ who: "me", zone: "graveyard" })} onDropCard={(id, from) => move(id, from, "graveyard")} onHover={setHover} />
            <MiniPile label={t("Exil")} count={z.exile.length} topCard={z.exile[z.exile.length - 1]}
              onClick={() => setViewer({ who: "me", zone: "exile" })} onDropCard={(id, from) => move(id, from, "exile")} onHover={setHover} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 10, flexWrap: "wrap" }}>
            {z.command.map((c) => (
              <div key={c.id} style={{ textAlign: "center" }} title={t("Cliquez pour lancer votre commandant")}>
                <div onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); try { const d = JSON.parse(e.dataTransfer.getData("text/plain")); move(d.id, d.from, "command"); } catch (er) {} }}>
                  <Card card={c} w={52} mine zone="command" onMenu={openMenu} onHover={setHover}
                    onTap={() => move(c.id, "command", "battlefield")} />
                </div>
                <div className="mp-l" style={{ marginTop: 4, fontSize: 8.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--gold)" }}>{t("★ Cmdt")}</div>
              </div>
            ))}
            {z.command.length === 0 && (
              <div className="mpile" title="Déposez votre commandant ici pour le renvoyer en zone de commandement"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); try { const d = JSON.parse(e.dataTransfer.getData("text/plain")); move(d.id, d.from, "command"); } catch (er) {} }}>
                <div className="mp-c" style={{ borderStyle: "dashed" }} />
                <div className="mp-l" style={{ color: "var(--gold)" }}>{t("★ Cmdt")}</div>
              </div>
            )}
          </div>
          <LifeOrb me name={pname} life={my.life} cmdDmg={my.cmdDmg} onLife={setLife} onCmd={setCmdDmg} />
        </div>

        {/* ===== table centrale ===== */}
        <div ref={centerRef} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative", zIndex: 1 }}>
          <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <OppHand count={opp ? opp.zones.hand.length : 0} />
            <Battlefield cards={opp ? opp.zones.battlefield : []} mine={false} mirror areaH={oppAreaH} areaW={rowW} cardHFix={cardHref} onHover={setHover}
              onMenu={(e, card, zone) => setMenu({ x: e.clientX, y: e.clientY, card, zone, opp: true })}
              waiting={!opp ? `${t("En attente d'adversaires — code")} ${code}` : undefined} />
          </div>

          <div className={"midline" + (myTurn ? " pulse" : "")}>
            <div className="gem">
              <span className="diam" />
              <span>{t("Tour")} {meta ? meta.turnNo || 1 : 1} · {meta ? (myTurn ? <b>{t("à vous de jouer")}</b> : `${t("tour de")} ${turnName || t("l'adversaire")}`) : ""}</span>
              <span className="diam" />
            </div>
          </div>

          <Battlefield cards={z.battlefield} mine areaH={myAreaH} areaW={rowW} cardHFix={cardHref} snap={snap} onPlace={placeAt} onTap={onBFTap}
            onMenu={openMenu} onHover={setHover} onTransform={transform} onAttachDrop={doAttach} attachMode={attachMode} />

          <HandFan cards={z.hand} vh={vh} zoneW={rowW} onPlay={(c) => move(c.id, "hand", "battlefield")}
            onMenu={openMenu} onHover={setHover} onDropCard={(id, from) => move(id, from, "hand")} />
        </div>

        {/* ===== rail droit : actions, tour, journal ===== */}
        <div className="rail right">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button className="btn gold" onClick={() => draw(1)}>{t("Piocher")}</button>
            <button className="btn" onClick={untapAll}>{t("Dégager tout")}</button>
            <button className="btn" onClick={doShuffle}>{t("Mélanger")}</button>
            <button className="btn" onClick={() => { setAskVal("7"); setAsk({ type: "mull", title: t("Mulligan — re-piocher combien ?"), num: true }); }}>Mulligan</button>
            <button className="btn" onClick={() => { setAskVal("3"); setAsk({ type: "look", title: t("Regarder le dessus"), num: true }); }}>{t("Regarder X")}</button>
            <button className="btn" onClick={() => { setAskVal("3"); setAsk({ type: "mill", title: t("Meuler — combien de cartes au cimetière ?"), num: true }); }}>{t("Meuler X")}</button>
            <button className="btn" onClick={() => { setViewer({ who: "me", zone: "library" }); addLog(t("cherche dans sa bibliothèque")); }}>{t("Chercher")}</button>
            <button className="btn" style={{ gridColumn: "1 / -1" }} onClick={() => setTokenPick(true)}>{t("+ Créer un jeton")}</button>
            <button className="btn" style={{ gridColumn: "1 / -1" }} onClick={() => { setAskVal(""); setAsk({ type: "group", title: t("Nom du groupe"), placeholder: t("ex. équipe d'attaque, enchantés…") }); }}>{t("⛓ Créer un groupe")}</button>
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8 }}>
            <button className={"btn ghost" + (snap ? " gold" : "")} title={t("Aimant : aligne les cartes posées sur les bandes")} onClick={() => setSnap((v) => !v)}>🧲</button>
            <button className="btn ghost" onClick={() => roll(2)}>{t("Pièce")}</button>
            <button className="btn ghost" onClick={() => roll(6)}>d6</button>
            <button className="btn ghost" onClick={() => roll(20)}>d20</button>
          </div>

          <button className="turnbtn" onClick={endTurn} disabled={!myTurn}>
            {myTurn ? t("Fin du tour") : t("Tour adverse")}
          </button>

          <div className="disp" style={{ fontSize: 9.5, color: "var(--dim)", margin: "2px 2px 6px" }}>{t("Journal")}</div>
          <div className="log" style={{ flex: 1 }}>
            {mergedLog.map((l, i) => <div key={l.t + "-" + i}><b>{l.who}</b> {l.msg}</div>)}
          </div>
        </div>
      </div>

      {/* ===== mini-dialogue ===== */}
      {ask && (
        <div className="modal-bg" onClick={() => setAsk(null)}>
          <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <h3 className="disp" style={{ margin: "0 0 10px", fontSize: 13, color: "var(--gold)" }}>
              {ask.title}
            </h3>
            <input autoFocus type={ask.num ? "number" : "text"} min={1} value={askVal}
              placeholder={ask.placeholder || (ask.num ? t("Nombre de cartes") : "")}
              onChange={(e) => setAskVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAsk(); }} />
            <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setAsk(null)}>{t("Annuler")}</button>
              <button className="btn gold" onClick={submitAsk}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== aide ===== */}
      {help && (
        <div className="modal-bg" onClick={() => setHelp(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <h3 className="disp" style={{ margin: "0 0 12px", fontSize: 15, color: "var(--gold)" }}>{t("Comment jouer")}</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 13.5 }}>
              {(UI_LANG === "en" ? HELP_EN : HELP_FR).map((h, i) => <div key={i} dangerouslySetInnerHTML={{ __html: h }} />)}
            </div>
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
              <button className="btn gold" onClick={() => setHelp(false)}>{t("Compris !")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== menu contextuel ===== */}
      {menu && (() => {
        const src = menu.opp ? ((opp && opp.zones[menu.zone]) || []) : (z[menu.zone] || []);
        const live = src.find((c) => c.id === menu.card.id) || menu.card;
        const groupNames = {};
        for (const g of z.battlefield) if (g.grp) groupNames[g.id] = dn(g);
        return <CardMenu menu={{ ...menu, card: live }} close={closeMenu} move={move} bump={bump} flip={flip} transform={transform} clone={clone} tap={tapToggle}
          setRow={setRow} attach={(id) => setAttachMode(id)} detach={detach} pickArt={(c) => setArtPick(c)}
          remove={removeCard} bumpMark={bumpMark} groupNames={groupNames} steal={stealFromOpp} giveBack={returnToOwner}
          link={(id) => setLinkMode(id)} unlink={toggleLink}
          nameMark={(c) => { setAskVal(""); setAsk({ type: "mark", cardId: c.id, title: t("Nom du marqueur"), placeholder: t("ex. poison, provoc, indestructible…") }); }} />;
      })()}

      {oppLibMenu && opp && (
        <div className="menu" style={{ left: Math.min(oppLibMenu.x, window.innerWidth - 250), top: Math.min(oppLibMenu.y, window.innerHeight - 210) }}
          onClick={(e) => e.stopPropagation()}>
          <div style={{ padding: "5px 10px", fontSize: 11.5, color: "var(--dim)", borderBottom: "1px solid var(--line)", marginBottom: 4, maxWidth: 230, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            📚 {t("Biblio")} · {oppName || curOppSeat} ({opp.zones.library.length})
          </div>
          <button onClick={() => { setOppLibMenu(null); stealOppTop("hand"); }}>🫳 {t("Voler la carte du dessus (→ ma main)")}</button>
          <button onClick={() => { setOppLibMenu(null); stealOppTop("battlefield"); }}>🫳 {t("Voler la carte du dessus (→ mon champ)")}</button>
          <button onClick={() => { setOppLibMenu(null); oppTopTo("exile"); }}>🚫 {t("Exiler la carte du dessus")}</button>
          <button onClick={() => { setOppLibMenu(null); oppTopTo("graveyard"); }}>🪦 {t("Meuler la carte du dessus")}</button>
          <button onClick={() => { setOppLibMenu(null); setViewer({ who: "opp", zone: "library", limit: 1 }); }}>👁 {t("Regarder la carte du dessus")}</button>
          <div className="sec"></div>
          <button onClick={() => { setOppLibMenu(null); setViewer({ who: "opp", zone: "library" }); }}>🔍 {t("Fouiller toute la bibliothèque")}</button>
        </div>
      )}

      {tokenPick && <TokenPicker onSpawn={spawnToken} close={() => setTokenPick(false)} onHover={setHover} />}

      {artPick && <ArtPicker card={artPick} close={() => setArtPick(null)} onHover={setHover}
        onPick={(p, all) => { applyArt(artPick, p, all); setArtPick(null); }} />}

      {/* ===== visionneuses ===== */}
      {viewer && <ZoneViewer viewer={viewer} my={my} opp={opp} move={move} doShuffle={doShuffle} close={() => setViewer(null)} onHover={setHover} steal={stealFromOpp} />}
      {topN && <TopViewer n={topN} my={my} move={move} close={() => setTopN(null)} onHover={setHover} />}

      {/* ===== aperçu ===== */}
      {hover && !hover.faceDown && fimg(hover) && (
        <div className="preview"><img src={fimgN(hover) || fimg(hover)} alt="" /><PreviewMarks card={hover} /></div>
      )}
      {hover && !hover.faceDown && !fimg(hover) && (
        <div className="preview">
          <div className="pv-txtwrap" style={{ background: "#1d1a26", border: "1px solid var(--gold)", borderRadius: 11, padding: 16, fontSize: 15, textAlign: "center" }}>{dn(hover)}</div>
          <PreviewMarks card={hover} />
        </div>
      )}
    </div>
  );
}

function CardMenu({ menu, close, move, bump, flip, transform, clone, tap, setRow, attach, detach, pickArt, remove, bumpMark, nameMark, link, unlink, groupNames = {}, steal, giveBack }) {
  const { card, zone, x, y } = menu;
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6));
    const top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
    setPos({ left, top, ready: true });
  }, [x, y, card.id, zone, Object.keys(card.marks || {}).length]);
  const it = (label, fn) => <button onClick={(e) => { e.stopPropagation(); fn(); close(); }}>{label}</button>;
  const itKeep = (label, fn) => <button onClick={(e) => { e.stopPropagation(); fn(); }}>{label}</button>;
  const sec = (label) => <div className="sec">{label}</div>;
  const markRows = (
    <>
      {card.marks && Object.entries(card.marks).map(([k, v]) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 4, padding: "1px 10px" }}>
          <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🏷 {k} <b style={{ color: "var(--gold)" }}>×{v}</b></span>
          <button className="lbtn" style={{ width: 20, height: 20, fontSize: 11 }} title={t("Retirer un marqueur") + " " + k}
            onClick={(e) => { e.stopPropagation(); bumpMark(card.id, k, -1); }}>−</button>
          <button className="lbtn" style={{ width: 20, height: 20, fontSize: 11 }} title={t("Ajouter un marqueur") + " " + k}
            onClick={(e) => { e.stopPropagation(); bumpMark(card.id, k, 1); }}>+</button>
        </div>
      ))}
    </>
  );
  if (menu.opp) return (
    <div className="menu" ref={ref} style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ padding: "5px 10px", fontSize: 11.5, color: "var(--dim)", borderBottom: "1px solid var(--line)", marginBottom: 4, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {card.faceDown ? t("Carte face cachée") : dn(card)}
      </div>
      {zone === "battlefield" && it(t("🫳 Prendre le contrôle"), () => steal(card, "battlefield", "battlefield"))}
      {zone === "battlefield" && it(t("🫳 Prendre en main"), () => steal(card, "battlefield", "hand"))}
    </div>
  );
  if (card.grp && zone === "battlefield") return (
    <div className="menu" ref={ref} style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ padding: "5px 10px", fontSize: 11.5, color: card.color || "var(--gold)", borderBottom: "1px solid var(--line)", marginBottom: 4, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>⛓ {t("Groupe")} · {dn(card)}</div>
      {it(t("⛓ Lier / délier des cartes (cliquez-les)"), () => link(card.id))}
      {sec(t("Marqueurs du groupe (appliqués aux cartes liées)"))}
      {itKeep(t("➕ Ajouter un marqueur"), () => bump(card.id, 1))}
      {itKeep(t("➖ Retirer un marqueur"), () => bump(card.id, -1))}
      {it(t("🏷 Marqueur nommé…"), () => nameMark(card))}
      {markRows}
      {sec(t("Déplacer vers la rangée"))}
      {it(t("🏔 Terrains"), () => setRow(card.id, "land"))}
      {it(t("🐉 Créatures"), () => setRow(card.id, "creature"))}
      {it(t("✨ Autres"), () => setRow(card.id, "other"))}
      {sec("")}
      {it(t("🗑 Supprimer le groupe (délie tout)"), () => remove(card, zone))}
    </div>
  );
  return (
    <div className="menu" ref={ref} style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ padding: "5px 10px", fontSize: 11.5, color: "var(--gold)", borderBottom: "1px solid var(--line)", marginBottom: 4, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.faceDown ? t("Carte face cachée") : dn(card)}</div>
      {zone === "hand" && <>
        {it(t("▶ Jouer"), () => move(card.id, "hand", "battlefield"))}
        {it(t("🙈 Jouer face cachée"), () => move(card.id, "hand", "battlefield", { faceDown: true }))}
        {it(t("🗑 Se défausser"), () => move(card.id, "hand", "graveyard"))}
      </>}
      {zone === "command" && it(t("⭐ Lancer le commandant"), () => move(card.id, "command", "battlefield"))}
      {zone === "battlefield" && <>
        {it(card.tapped ? t("↺ Dégager") : t("⤵ Engager"), () => tap(card))}
        {card.host ? it(t("✂ Détacher"), () => detach(card.id)) : it(t("🔗 Attacher à… (cliquez la cible)"), () => attach(card.id))}
        {sec(t("Marqueurs & état"))}
        {itKeep(t("➕ Ajouter un marqueur"), () => bump(card.id, 1))}
        {itKeep(t("➖ Retirer un marqueur"), () => bump(card.id, -1))}
        {it(t("🏷 Marqueur nommé…"), () => nameMark(card))}
        {markRows}
        {card.groups && Object.keys(card.groups).map((gid) => (
          <button key={gid} onClick={(e) => { e.stopPropagation(); unlink(gid, card); }}>
            <span className="grpdot" style={{ background: card.groups[gid], display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
            ✂ {t("Délier de")} « {groupNames[gid] || t("groupe")} »
          </button>
        ))}
        {card.dfc && transform && !card.faceDown && it(t("⟳ Transformer"), () => transform(card.id))}
        {it(card.faceDown ? t("👁 Face visible") : t("🙈 Face cachée"), () => flip(card.id))}
        {it(t("🪙 Copie-jeton"), () => clone(card))}
        {sec(t("Déplacer vers la rangée"))}
        {it(t("🏔 Terrains"), () => setRow(card.id, "land"))}
        {it(t("🐉 Créatures"), () => setRow(card.id, "creature"))}
        {it(t("✨ Autres"), () => setRow(card.id, "other"))}
      </>}
      {card.ownerSeat && zone === "battlefield" && it(t("↩ Rendre au propriétaire"), () => giveBack(card))}
      {!card.faceDown && it(t("🎨 Changer l'illustration…"), () => pickArt(card))}
      {card.token && it(t("🗑 Supprimer le jeton"), () => remove(card, zone))}
      {sec(t("Envoyer vers"))}
      {zone !== "hand" && it(t("✋ Main"), () => move(card.id, zone, "hand"))}
      {zone !== "graveyard" && it(t("🪦 Cimetière"), () => move(card.id, zone, "graveyard"))}
      {zone !== "exile" && it(t("🚫 Exil"), () => move(card.id, zone, "exile"))}
      {card.isCmdr && zone !== "command" && it(t("⭐ Zone de commandement"), () => move(card.id, zone, "command"))}
      {it(t("📚 Dessus de la bibliothèque"), () => move(card.id, zone, "library"))}
      {it(t("📚 Dessous de la bibliothèque"), () => move(card.id, zone, "library", { bottom: true }))}
    </div>
  );
}

function ArtPicker({ card, onPick, close, showAll = true, onHover }) {
  const [prints, setPrints] = useState(null);
  const [all, setAll] = useState(true);
  useEffect(() => () => { if (onHover) onHover(null); }, []); // pas d'aperçu figé à la fermeture
  useEffect(() => {
    let stop = false;
    (async () => {
      const out = [];
      const q = `!"${card.name.replace(/"/g, "")}" (lang:fr or lang:en) include:extras`;
      let url = "https://api.scryfall.com/cards/search?unique=prints&order=released&q=" + encodeURIComponent(q);
      try {
        for (let p = 0; p < 4 && url; p++) {
          const r = await fetch(url); if (!r.ok) break;
          const d = await r.json();
          for (const c of d.data || []) {
            const iu = c.image_uris || (c.card_faces && c.card_faces[0].image_uris);
            const bf = !c.image_uris && c.card_faces && c.card_faces[1] && c.card_faces[1].image_uris;
            if (iu) out.push({ id: c.id, s: iu.small, n: iu.normal, set: (c.set || "").toUpperCase(),
              setName: c.set_name, lang: c.lang, fn: c.printed_name || (c.card_faces && c.card_faces[0].printed_name) || null,
              // face arrière de cette impression, pour garder le recto-verso
              ...(bf ? { bs: bf.small, bn: bf.normal, bfn: c.card_faces[1].printed_name || c.card_faces[1].name || null } : {}) });
          }
          url = d.has_more ? d.next_page : null;
        }
      } catch (e) {}
      if (!stop) setPrints(out);
    })();
    return () => { stop = true; };
  }, [card.name]);
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <h3 className="disp" style={{ margin: 0, fontSize: 14, color: "var(--gold)", textTransform: "none", letterSpacing: ".06em" }}>
            Illustration — {dn(card)}{prints ? ` (${prints.length} versions)` : ""}
          </h3>
          <div className="row">
            <button className="btn ghost" onClick={() => onPick(null, showAll ? all : false)}>{t("↩ Illustration par défaut")}</button>
            <button className="btn ghost" onClick={close}>{t("Fermer ✕")}</button>
          </div>
        </div>
        {showAll && (
          <label className="hint" style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ width: "auto" }} />
            {t("Appliquer à tous les exemplaires de")} « {card.name} » {t("et mémoriser dans le deck")}
          </label>
        )}
        {!prints && <div className="hint" style={{ padding: 30, textAlign: "center" }}>{t("Recherche des impressions sur Scryfall…")}</div>}
        {prints && prints.length === 0 && <div className="hint" style={{ padding: 30, textAlign: "center" }}>{t("Aucune impression trouvée pour cette carte.")}</div>}
        {prints && prints.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {prints.map((p) => (
              <div key={p.id} onClick={() => onPick(p, all)} title={`${p.setName} — ${t("cliquez pour choisir")}`}
                style={{ width: 118, cursor: "pointer" }}
                onMouseEnter={() => onHover && onHover({ img: p.s, imgN: p.n, name: card.name, fn: p.fn })}
                onMouseLeave={() => onHover && onHover(null)}>
                <div className="card-i" style={{ height: 165 }}><img src={p.s} alt={p.setName} loading="lazy" /></div>
                <div className="hint" style={{ marginTop: 3, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.set} · {p.lang.toUpperCase()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* raccourcis de jetons : libellé français + terme de recherche anglais */
const QUICK_TOKENS = [
  { fr: "Trésor", en: "Treasure" }, { fr: "Nourriture", en: "Food" }, { fr: "Indice", en: "Clue" },
  { fr: "Sang", en: "Blood" }, { fr: "Carte", en: "Map" }, { fr: "Soldat", en: "Soldier" },
  { fr: "Zombie", en: "Zombie" }, { fr: "Gobelin", en: "Goblin" }, { fr: "Esprit", en: "Spirit" },
  { fr: "Ange", en: "Angel" }, { fr: "Dragon", en: "Dragon" }, { fr: "Bête", en: "Beast" },
  { fr: "Élémental", en: "Elemental" }, { fr: "Saprolin", en: "Saproling" }, { fr: "Insecte", en: "Insect" },
  { fr: "Ornithoptère", en: "Thopter" },
];
/* dictionnaire français → anglais pour chercher les jetons en tapant en français.
   Les noms de jetons de Scryfall sont en anglais : on traduit chaque mot saisi. */
const TOKEN_FR = {
  // artefacts / marqueurs courants
  "tresor": "Treasure", "nourriture": "Food", "indice": "Clue", "sang": "Blood", "carte": "Map",
  "or": "Gold", "pierre de puissance": "Powerstone", "reliquaire": "Shard", "citoyen": "Citizen",
  "incubateur": "Incubator", "petrole": "Oil", "role": "Role",
  // créatures fréquentes
  "soldat": "Soldier", "zombie": "Zombie", "gobelin": "Goblin", "esprit": "Spirit", "ange": "Angel",
  "dragon": "Dragon", "bete": "Beast", "elemental": "Elemental", "saprolin": "Saproling",
  "insecte": "Insect", "ornithoptere": "Thopter", "chat": "Cat", "chien": "Dog", "loup": "Wolf",
  "ours": "Bear", "elan": "Elk", "rat": "Rat", "serpent": "Snake", "araignee": "Spider",
  "chauve-souris": "Bat", "squelette": "Skeleton", "guerrier": "Warrior", "chevalier": "Knight",
  "clerc": "Cleric", "sorcier": "Wizard", "voleur": "Rogue", "pirate": "Pirate", "dinosaure": "Dinosaur",
  "hydre": "Hydra", "demon": "Demon", "diablotin": "Imp", "faerie": "Faerie", "fee": "Faerie",
  "golem": "Golem", "myr": "Myr", "construction": "Construct", "serviteur": "Servo", "reptile": "Lizard",
  "lezard": "Lizard", "oiseau": "Bird", "chevre": "Goat", "cochon": "Boar", "sanglier": "Boar",
  "elephant": "Elephant", "rhinoceros": "Rhino", "cheval": "Horse", "licorne": "Unicorn",
  "pegase": "Pegasus", "griffon": "Griffin", "kraken": "Kraken", "leviathan": "Leviathan",
  "pieuvre": "Octopus", "poisson": "Fish", "grenouille": "Frog", "crapaud": "Frog", "tortue": "Turtle",
  "abeille": "Bee", "guepe": "Wasp", "scorpion": "Scorpion", "loup-garou": "Werewolf",
  "vampire": "Vampire", "geant": "Giant", "ogre": "Ogre", "troll": "Troll", "orque": "Orc",
  "kobold": "Kobold", "nain": "Dwarf", "elfe": "Elf", "gnome": "Gnome", "kavu": "Kavu",
  "sabliste": "Sand", "goule": "Zombie", "moine": "Monk", "ninja": "Ninja", "samourai": "Samurai",
  "assassin": "Assassin", "mercenaire": "Mercenary", "pilote": "Pilot", "citoyenne": "Citizen",
  "pretre": "Cleric", "druide": "Druid", "chaman": "Shaman", "berserker": "Berserker",
  "avatar": "Avatar", "ange-gardien": "Angel", "phenix": "Phoenix", "phénix": "Phoenix",
  "serpent-de-mer": "Serpent", "hippogriffe": "Hippogriff", "sphinx": "Sphinx", "meduse": "Gorgon",
  "gorgone": "Gorgon", "harpie": "Harpy", "spectre": "Wraith", "fantome": "Spirit",
  "mille-pattes": "Centipede", "scarabee": "Beetle", "papillon": "Butterfly", "renard": "Fox",
  "belette": "Weasel", "furet": "Ferret", "castor": "Beaver", "ecureuil": "Squirrel",
  "cerf": "Elk", "biche": "Elk", "singe": "Ape", "gorille": "Ape", "crabe": "Crab",
  "requin": "Shark", "baleine": "Whale", "dauphin": "Dolphin", "meduse-jelly": "Jellyfish",
  "salamandre": "Salamander", "basilic": "Basilisk", "wyrm": "Wurm", "wurm": "Wurm",
  "traqueur": "Horror", "horreur": "Horror", "cauchemar": "Nightmare", "golem-de-chair": "Zombie",
  "pilier": "Wall", "mur": "Wall", "totem": "Totem", "fantassin": "Soldier", "eclaireur": "Scout",
  "archer": "Archer", "barde": "Bard", "rodeur": "Ranger", "paladin": "Knight",
};

function TokenPicker({ onSpawn, close, onHover }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null); // null = rien cherché, [] = aucun résultat
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState({}); // id -> nombre créé
  const [cn, setCn] = useState("");   // jeton personnalisé : nom
  const [cpt, setCpt] = useState(""); // jeton personnalisé : F/E
  const tRef = useRef(null);
  const makeCustom = () => {
    const name = cn.trim(); if (!name) return;
    pick({ id: "txt-" + name.toLowerCase() + "-" + cpt.trim(), name, fn: name, s: null, n: null, t: "creature", pt: cpt.trim() || null });
  };
  /* traduit ce que l'utilisateur tape (français) vers l'anglais, mot à mot,
     car les noms de jetons de Scryfall sont en anglais. Les mots inconnus
     (déjà en anglais, chiffres comme « 1/1 »…) sont conservés tels quels. */
  const toEnglish = (term) => {
    const whole = TOKEN_FR[norm(term)];
    if (whole) return whole;
    return term.split(/\s+/).map((w) => TOKEN_FR[norm(w)] || w).join(" ");
  };
  const mapCards = (data) => {
    const out = [];
    for (const c of data || []) {
      const iu = c.image_uris || (c.card_faces && c.card_faces[0].image_uris);
      const fn = c.printed_name || (c.card_faces && c.card_faces[0].printed_name) || c.name;
      out.push({ id: c.id, name: c.name, fn, s: iu ? iu.small : null, n: iu ? iu.normal : null,
        t: typeCat(c.type_line), pt: c.power != null ? `${c.power}/${c.toughness}` : null, type: c.type_line });
    }
    return out;
  };
  const search = async (term) => {
    term = term.trim();
    if (!term) { setRes(null); return; }
    setBusy(true);
    const en = toEnglish(term);
    const run = async (fr) => {
      const q = `t:token include:extras ${fr ? "lang:fr " : ""}${en}`;
      const r = await fetch("https://api.scryfall.com/cards/search?order=name&unique=cards&q=" + encodeURIComponent(q));
      return r.ok ? await r.json() : { data: [] };
    };
    try {
      // 1) on tente d'abord les impressions françaises (nom + image en français)
      let d = await run(true);
      // 2) rien en français ? on retombe sur l'anglais pour ne rien manquer
      if (!d.data || d.data.length === 0) d = await run(false);
      setRes(mapCards(d.data));
    } catch (e) { setRes([]); }
    setBusy(false);
  };
  const onChange = (v) => { setQ(v); clearTimeout(tRef.current); tRef.current = setTimeout(() => search(v), 450); };
  const pick = (tk) => { onSpawn(tk); setMade((m) => ({ ...m, [tk.id]: (m[tk.id] || 0) + 1 })); };
  useEffect(() => () => { if (onHover) onHover(null); }, []); // évite un aperçu figé à la fermeture
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h3 className="disp" style={{ margin: 0, fontSize: 14, color: "var(--gold)", textTransform: "none", letterSpacing: ".06em" }}>{t("Créer un jeton")}</h3>
          <button className="btn ghost" onClick={close}>{t("Fermer ✕")}</button>
        </div>
        <input autoFocus placeholder={t("Rechercher un jeton (français ou anglais)… ex. Trésor, Soldat, 1/1")} value={q}
          onChange={(e) => onChange(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
          {QUICK_TOKENS.map((tk) => {
            const label = UI_LANG === "en" ? tk.en : tk.fr;
            return (
              <button key={tk.en} className="btn ghost" style={{ padding: "3px 9px", fontSize: 11 }}
                onClick={() => { setQ(label); search(tk.en); }}>{label}</button>
            );
          })}
        </div>
        <div className="row" style={{ marginBottom: 10, alignItems: "center", gap: 6 }}>
          <span className="hint" style={{ flex: "none" }}>{t("Sans image :")}</span>
          <input placeholder={t("Nom du jeton (ex. Zombie décharné)")} value={cn} onChange={(e) => setCn(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") makeCustom(); }} style={{ flex: 1, minWidth: 160 }} />
          <input placeholder={t("F/E (ex. 2/2)")} value={cpt} onChange={(e) => setCpt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") makeCustom(); }} style={{ width: 100, flex: "none" }} />
          <button className="btn gold" style={{ flex: "none" }} onClick={makeCustom}>{t("Créer")}</button>
        </div>
        {busy && <div className="hint" style={{ padding: 20, textAlign: "center" }}>{t("Recherche…")}</div>}
        {!busy && res === null && <div className="hint" style={{ padding: 14, textAlign: "center" }}>{t("Tapez un nom ou cliquez un raccourci ci-dessus. Chaque clic sur un résultat crée un jeton (cliquez plusieurs fois pour plusieurs exemplaires).")}</div>}
        {!busy && res && res.length === 0 && (
          <div className="hint" style={{ padding: 14, textAlign: "center" }}>
            {t("Aucun jeton trouvé (ou réseau indisponible).")}{" "}
            {q.trim() && <button className="btn ghost" onClick={() => pick({ id: "txt-" + q.trim().toLowerCase(), name: q.trim(), fn: q.trim(), s: null, n: null, t: "creature", pt: cpt.trim() || null })}>{t("Créer")} « {q.trim()} » {t("sans image")}</button>}
          </div>
        )}
        {!busy && res && res.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {res.map((tk) => (
              <div key={tk.id} onClick={() => pick(tk)} title={`${tk.type} — ${t("cliquez pour créer")}`} style={{ width: 118, cursor: "pointer", position: "relative" }}
                onMouseEnter={() => onHover && onHover({ img: tk.s, imgN: tk.n, name: tk.name, fn: tk.fn })}
                onMouseLeave={() => onHover && onHover(null)}>
                <div className="card-i" style={{ height: 165 }}>
                  {tk.s ? <img src={tk.s} alt={tk.fn || tk.name} loading="lazy" /> : <div className="card-txt">{tk.fn || tk.name}</div>}
                </div>
                {made[tk.id] > 0 && <div className="badge">✓ ×{made[tk.id]}</div>}
                <div className="hint" style={{ marginTop: 3, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tk.fn || tk.name}{tk.pt ? ` · ${tk.pt}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ZoneViewer({ viewer, my, opp, move, doShuffle, close, onHover, steal }) {
  const [q, setQ] = useState("");
  useEffect(() => () => { if (onHover) onHover(null); }, []); // pas d'aperçu figé à la fermeture
  const isMe = viewer.who === "me";
  const owner = isMe ? my : opp;
  if (!owner) return null;
  const all = owner.zones[viewer.zone] || [];
  const cards = viewer.limit ? all.slice(0, viewer.limit) : all;
  const nq = norm(q);
  const shown = nq ? cards.filter((c) => norm(c.name).includes(nq) || norm(dn(c)).includes(nq) || (c.fn && norm(c.fn).includes(nq))) : cards;
  const showFilter = !viewer.limit && cards.length > 4;
  const title = viewer.limit
    ? `${t("Dessus de")} ${t(ZLBL[viewer.zone])} — ${owner.name}`
    : `${t(ZLBL[viewer.zone])} — ${owner.name} (${all.length})`;
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h3 className="disp" style={{ margin: 0, fontSize: 14, color: "var(--gold)", textTransform: "none", letterSpacing: ".06em" }}>{title}</h3>
          <div className="row">
            {isMe && viewer.zone === "library" && <button className="btn" onClick={() => { doShuffle(); close(); }}>{t("Mélanger & fermer")}</button>}
            <button className="btn ghost" onClick={close}>{t("Fermer ✕")}</button>
          </div>
        </div>
        {showFilter && (
          <div className="row" style={{ marginBottom: 12, alignItems: "center", gap: 8 }}>
            <input autoFocus placeholder={t("Filtrer (nom français ou anglais)…")} value={q}
              onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
            <span className="hint" style={{ flex: "none" }}>{shown.length} / {cards.length}</span>
            {q && <button className="btn ghost" style={{ flex: "none" }} onClick={() => setQ("")}>{t("Effacer")}</button>}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {shown.map((c) => (
            <div key={c.id} style={{ width: 96 }}>
              <div className="card-i" style={{ height: 134 }} onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)}>
                {fimg(c) ? <img src={fimg(c)} alt={dn(c)} /> : <div className="card-txt">{dn(c)}</div>}
              </div>
              {isMe && (
                <div style={{ display: "flex", gap: 3, marginTop: 4, flexWrap: "wrap" }}>
                  <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} onClick={() => move(c.id, viewer.zone, "hand")}>{t("Main")}</button>
                  <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} onClick={() => move(c.id, viewer.zone, "battlefield")}>{t("Champ")}</button>
                  {viewer.zone !== "graveyard" && <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} onClick={() => move(c.id, viewer.zone, "graveyard")}>{t("Cim.")}</button>}
                </div>
              )}
              {!isMe && steal && (
                <div style={{ display: "flex", gap: 3, marginTop: 4, flexWrap: "wrap" }}>
                  <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} title={t("Prendre cette carte (effet de vol)")}
                    onClick={() => steal(c, viewer.zone, "hand")}>🫳 {t("Main")}</button>
                  <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} title={t("Prendre cette carte (effet de vol)")}
                    onClick={() => steal(c, viewer.zone, "battlefield")}>🫳 {t("Champ")}</button>
                </div>
              )}
            </div>
          ))}
          {shown.length === 0 && <div className="hint">{cards.length === 0 ? t("Zone vide.") : t("Aucune carte ne correspond.")}</div>}
        </div>
        {isMe && viewer.zone === "library" && <div className="hint" style={{ marginTop: 10 }}>{t("N'oubliez pas de mélanger après une recherche !")}</div>}
      </div>
    </div>
  );
}

function TopViewer({ n, my, move, close, onHover }) {
  const top = my.zones.library.slice(0, n);
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h3 className="disp" style={{ margin: 0, fontSize: 14, color: "var(--gold)" }}>{t("Dessus de la bibliothèque")}</h3>
          <button className="btn ghost" onClick={close}>{t("Terminé ✕")}</button>
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>{t("De gauche (dessus) à droite. Les cartes laissées restent dans cet ordre.")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {top.map((c, i) => (
            <div key={c.id} style={{ width: 96 }}>
              <div className="hint" style={{ textAlign: "center" }}>#{i + 1}</div>
              <div className="card-i" style={{ height: 134 }} onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)}>
                {fimg(c) ? <img src={fimg(c)} alt={dn(c)} /> : <div className="card-txt">{dn(c)}</div>}
              </div>
              <div style={{ display: "flex", gap: 3, marginTop: 4, flexWrap: "wrap" }}>
                <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} onClick={() => move(c.id, "library", "hand")}>{t("Main")}</button>
                <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} onClick={() => move(c.id, "library", "library", { bottom: true })}>{t("Dessous")}</button>
                <button className="btn ghost" style={{ padding: "2px 6px", fontSize: 10 }} onClick={() => move(c.id, "library", "graveyard")}>{t("Cim.")}</button>
              </div>
            </div>
          ))}
          {top.length === 0 && <div className="hint">{t("Bibliothèque vide.")}</div>}
        </div>
      </div>
    </div>
  );
}

/* ---------- application ---------- */
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return (
      <div style={{ maxWidth: 600, margin: "60px auto", padding: 20, background: "var(--panel)", border: "1px solid var(--red)", borderRadius: 14 }}>
        <h3 className="disp" style={{ color: "#e07b63", marginTop: 0 }}>{t("Oups, une erreur est survenue")}</h3>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "var(--dim)" }}>{String(this.state.err && this.state.err.message || this.state.err)}</pre>
        <button className="btn gold" onClick={() => location.reload()}>{t("Recharger la page")}</button>
      </div>
    );
    return this.props.children;
  }
}

function App() {
  const [room, setRoom] = useState(null);
  const [uiLang, setUiLang] = useState("fr");
  useEffect(() => { (async () => { const l = await sget("mtg-lang"); if (l === "en" || l === "fr") setUiLang(l); })(); }, []);
  useEffect(() => { document.body.classList.toggle("en", uiLang === "en"); }, [uiLang]);
  const changeLang = (l) => { setUiLang(l); sset("mtg-lang", l); };
  UI_LANG = uiLang; // lu par t() dans tout l'arbre, re-rendu à chaque changement
  /* état "dragging" global : la classe est posée au début d'un glisser et
     retirée par PLUSIEURS filets de sécurité (dragend, drop, souris relâchée),
     car "dragend" ne se déclenche pas si la carte d'origine a été déplacée. */
  useEffect(() => {
    let active = false;
    /* on diffère l'ajout d'une frame : modifier les styles pendant le
       dragstart lui-même peut faire annuler le drag par Chrome */
    const on = () => { active = true; requestAnimationFrame(() => { if (active) document.body.classList.add("dragging"); }); };
    const off = () => { active = false; document.body.classList.remove("dragging"); };
    const safety = (e) => { if (e.buttons === 0) off(); };
    window.addEventListener("dragstart", on, true);
    window.addEventListener("dragend", off, true);
    window.addEventListener("drop", off, true);
    window.addEventListener("mouseup", off);
    window.addEventListener("mousemove", safety);
    return () => {
      window.removeEventListener("dragstart", on, true);
      window.removeEventListener("dragend", off, true);
      window.removeEventListener("drop", off, true);
      window.removeEventListener("mouseup", off);
      window.removeEventListener("mousemove", safety);
      off();
    };
  }, []);
  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="table-bg" />
      <ErrorBoundary>
        {room ? <Game room={room} onQuit={() => setRoom(null)} uiLang={uiLang} onLang={changeLang} /> : <Lobby onStart={setRoom} uiLang={uiLang} onLang={changeLang} />}
      </ErrorBoundary>
    </div>
  );
}


ReactDOM.createRoot(document.getElementById("root")).render(<App />);
