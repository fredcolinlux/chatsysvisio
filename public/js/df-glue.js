// Liaison minimale avec libDF (DeepFilterNet3 compilé en WebAssembly par wasm-bindgen) : création de l'état avec les
// poids intégrés, traitement d'une trame de 480 échantillons à 48 kHz, limite d'atténuation réglable à chaud.
// Écrit pour ChatSysVisio (AGPL-3.0-or-later) ; utilisable dans un AudioWorklet (aucune API du DOM) et dans Node.
export function dfInit(module) {
  let w = null, f32 = null, u8 = null;
  const F32 = () => (f32 && f32.buffer === w.memory.buffer ? f32 : (f32 = new Float32Array(w.memory.buffer)));
  const U8 = () => (u8 && u8.buffer === w.memory.buffer ? u8 : (u8 = new Uint8Array(w.memory.buffer)));
  // L'AudioWorkletGlobalScope n'a ni TextDecoder ni crypto : messages d'erreur décodés à la main ; aléa (graines des
  // tables de hachage de Rust, sans usage cryptographique) pris sur Math.random si crypto manque.
  const text = (p, l) => { const b = U8().slice(p, p + l); if (typeof TextDecoder === 'function') return new TextDecoder().decode(b); let t = ''; for (const c of b) t += String.fromCharCode(c); try { return decodeURIComponent(escape(t)); } catch { return t; } };
  const fill = a => { if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a); else for (let i = 0; i < a.length; i++) a[i] = Math.random() * 256 | 0; };
  const imports = {}, list = WebAssembly.Module.imports(module);
  for (const { name } of list) {
    imports[name] = name.includes('new_from_slice') ? (p, l) => new Float32Array(F32().subarray(p / 4, p / 4 + l))
      : name.includes('getRandomValues') ? (p, l) => {
        try { fill(U8().subarray(p, p + l)); }
        catch (e) { const k = w.__externref_table_alloc_command_export(); w.__wbindgen_externrefs.set(k, e); w.__wbindgen_exn_store_command_export(k); }
      }
      : name.includes('wbindgen_throw') ? (p, l) => { throw new Error(text(p, l)); }
      : name.includes('init_externref_table') ? () => {
        const t = w.__wbindgen_externrefs, o = t.grow(4);
        t.set(0, undefined); t.set(o, undefined); t.set(o + 1, null); t.set(o + 2, true); t.set(o + 3, false);
      }
      : () => { throw new Error('libDF : import inattendu ' + name); };
  }
  w = new WebAssembly.Instance(module, { [list[0].module]: imports }).exports;
  w.__wbindgen_start();
  const malloc = w.__wbindgen_malloc_command_export;
  return {
    // atténuation maximale du bruit en dB (100 = sans limite)
    create(attenLimDb) { return w.df_create_default(attenLimDb) >>> 0; },
    frameLength: st => w.df_get_frame_length(st) >>> 0,
    process(st, x) { const p = malloc(x.length * 4, 4) >>> 0; F32().set(x, p / 4); return w.df_process_frame(st, p, x.length); },
    setAttenLim: (st, db) => w.df_set_atten_lim(st, db),
    free: st => w.df_free?.(st),
  };
}
