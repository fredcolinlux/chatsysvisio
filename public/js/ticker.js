// Minuterie dans un Worker : n'est pas bridée quand l'onglet passe en arrière-plan (la vidéo continue).
let t = null;
onmessage = e => { clearInterval(t); t = null; if (e.data > 0) t = setInterval(() => postMessage(0), e.data); };
