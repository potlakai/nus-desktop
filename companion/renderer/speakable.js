// What the Knot's voice is handed: the reply as it should sound, not as it is
// written. Both voices (Kokoro and the system voice) read symbols literally,
// so homework answers came out as "backslash frac" and "dollar x caret two",
// links were spelled out, and bullets became "dash". The bubble still shows
// the written text; only speech goes through here.
//
// Pure and conservative: only what a voice reads badly is changed. Shared by
// the renderer (window.NusSpeakable) and tests (module.exports).
(function (root) {
  'use strict';

  const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'phi', 'chi', 'psi', 'omega'];
  const WORDS = {
    times: ' times ', cdot: ' times ', div: ' divided by ', pm: ' plus or minus ', mp: ' minus or plus ',
    le: ' is at most ', leq: ' is at most ', ge: ' is at least ', geq: ' is at least ', lt: ' is less than ', gt: ' is greater than ',
    neq: ' is not equal to ', ne: ' is not equal to ', approx: ' is about ', equiv: ' is equivalent to ', propto: ' is proportional to ',
    infty: ' infinity ', to: ' goes to ', rightarrow: ' goes to ', Rightarrow: ' implies ', implies: ' implies ', iff: ' if and only if ',
    sum: ' the sum of ', prod: ' the product of ', int: ' the integral of ', lim: ' the limit ', partial: ' partial ', nabla: ' del ',
    in: ' in ', notin: ' not in ', subset: ' a subset of ', cup: ' union ', cap: ' intersect ', forall: ' for all ', exists: ' there exists ',
    degree: ' degrees ', circ: ' degrees ', ldots: ' and so on ', cdots: ' and so on ', dots: ' and so on ',
    sin: ' sine ', cos: ' cosine ', tan: ' tangent ', log: ' log ', ln: ' natural log ', exp: ' e to the ',
  };
  for (const g of GREEK) { WORDS[g] = ' ' + g + ' '; WORDS[g[0].toUpperCase() + g.slice(1)] = ' ' + g + ' '; }
  const SYMBOLS = [
    [/≤/g, ' is at most '], [/≥/g, ' is at least '], [/≠/g, ' is not equal to '], [/≈/g, ' is about '],
    [/×/g, ' times '], [/÷/g, ' divided by '], [/±/g, ' plus or minus '], [/√/g, ' the square root of '],
    [/∞/g, ' infinity '], [/π/g, ' pi '], [/θ/g, ' theta '], [/Δ/g, ' delta '], [/°/g, ' degrees '],
    [/→|⟶/g, ' to '], [/⇒/g, ' implies '], [/²/g, ' squared'], [/³/g, ' cubed'], [/∑/g, ' the sum of '],
  ];

  // The {...} group that starts at s[i] (s[i] === '{'), or one character.
  function group(s, i) {
    if (s[i] !== '{') return { body: s[i] || '', end: i + 1 };
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
    }
    return { body: s.slice(i + 1), end: s.length };
  }

  function power(p) {
    const t = p.trim();
    if (t === '2') return ' squared ';
    if (t === '3') return ' cubed ';
    if (t === '-1') return ' inverse ';
    if (t === 'T') return ' transpose ';
    return ' to the ' + (/^\d+$/.test(t) ? t + ordinal(Number(t)) : mathWords(t).trim()) + ' ';
  }
  function ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return 'th';
    return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  }

  // TeX inside $...$ (or a bare expression) -> words.
  function mathWords(tex) {
    let s = String(tex);
    let out = '';
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (c === '\\') {
        const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
        const name = m ? m[1] : '';
        i += m ? m[0].length : 1;
        while (s[i] === ' ') i++;
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const a = group(s, i); const b = group(s, a.end); i = b.end;
          out += ' ' + mathWords(a.body).trim() + ' over ' + mathWords(b.body).trim() + ' ';
        } else if (name === 'sqrt') {
          let n = '';
          if (s[i] === '[') { const close = s.indexOf(']', i); n = s.slice(i + 1, close); i = close + 1; }
          const a = group(s, i); i = a.end;
          out += (n === '3' ? ' the cube root of ' : n ? ' the ' + n + 'th root of ' : ' the square root of ') + mathWords(a.body).trim() + ' ';
        } else if (/^(text|mathrm|mathbf|mathit|operatorname|textbf|mathbb)$/.test(name)) {
          const a = group(s, i); i = a.end; out += ' ' + mathWords(a.body).trim() + ' ';
        } else if (/^(left|right|big|Big|bigg|Bigg|displaystyle|quad|qquad|,|;|!| )$/.test(name)) {
          out += ' ';
        } else if (WORDS[name]) out += WORDS[name];
        else out += ' ' + name + ' ';
      } else if (c === '^') {
        const a = group(s, i + 1); i = a.end; out += power(a.body);
      } else if (c === '_') {
        const a = group(s, i + 1); i = a.end; out += ' sub ' + mathWords(a.body).trim() + ' ';
      } else if (c === '{' || c === '}') { out += ' '; i++; }
      else if (c === '=') { out += ' equals '; i++; }
      else if (c === '+') { out += ' plus '; i++; }
      else if (c === '-' && /[\w)}\s]/.test(s[i - 1] || '') && /[\s\w(\\{]/.test(s[i + 1] || '')) { out += ' minus '; i++; }
      else if (c === '-') { out += ' negative '; i++; }
      else if (c === '*') { out += ' times '; i++; }
      else if (c === '/') { out += ' over '; i++; }
      else if (c === '<') { out += ' is less than '; i++; }
      else if (c === '>') { out += ' is greater than '; i++; }
      else if (c === '&') { out += ' '; i++; }
      else { out += c; i++; }
    }
    return out.replace(/\s+/g, ' ');
  }

  function hostOf(url) {
    const m = /^https?:\/\/(?:www\.)?([^/?#\s]+)/i.exec(url);
    return m ? m[1].replace(/[.,;:!?)]+$/, '') : 'the link';
  }

  function speakable(text) {
    let s = String(text == null ? '' : text);
    // Code is read on screen, never aloud.
    s = s.replace(/```[\s\S]*?(```|$)/g, ' The code is in the bubble. ');
    // Display and inline maths.
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => ' ' + mathWords(m) + ' ')
         .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => ' ' + mathWords(m) + ' ')
         .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => ' ' + mathWords(m) + ' ')
         .replace(/(^|[^\\\w$])\$(?!\s)([^$\n]{1,200}?)(?<!\s)\$(?!\d)/g, (_, pre, m) => pre + ' ' + mathWords(m) + ' ');
    // Bare TeX commands outside dollar signs (\frac{1}{2}, x^{2}).
    s = s.replace(/\\(?:d?frac|sqrt)\s*(\{[^{}]*\}|\[[^\]]*\]\{[^{}]*\})(\{[^{}]*\})?/g, (m) => ' ' + mathWords(m) + ' ');
    s = s.replace(/([A-Za-z0-9)\]])\^(\{[^{}]+\}|-?\d+|[A-Za-z])/g, (_, base, p) => base + power(p.replace(/^\{|\}$/g, '')));
    // Links: the words, or where it goes.
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
         .replace(/<?(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])>?/g, (_, u) => hostOf(u));
    // Markdown structure.
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
         .replace(/^\s*>\s?/gm, '')
         .replace(/^\s*(?:[-*•+]|\d+[.)])\s+(.+?)\s*$/gm, (_, item) => item + (/[.!?:;]$/.test(item) ? ' ' : '. '))
         .replace(/`([^`]+)`/g, '$1')
         .replace(/(\*\*|__)(.+?)\1/g, '$2')
         .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
         .replace(/\|/g, ', ');
    // Symbols a voice spells out.
    for (const [re, w] of SYMBOLS) s = s.replace(re, w);
    s = s.replace(/\b([CF])#(?![\w#])/g, '$1 sharp').replace(/\bC\+\+(?!\w)/g, 'C plus plus');
    s = s.replace(/\s->\s|\s-->\s/g, ' to ').replace(/\s=>\s/g, ' gives ').replace(/\s&\s/g, ' and ')
         .replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,')
         .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
         .replace(/[#*_~>`\\]/g, ' ')
         .replace(/[{}]/g, ' ');
    return s.replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').replace(/([.!?])\s*\.(?=\s|$)/g, '$1').trim();
  }

  const api = { speakable, mathWords };
  root.NusSpeakable = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
