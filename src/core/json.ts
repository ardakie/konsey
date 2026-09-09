/**
 * Ajan ciktilarindan JSON ayikla.
 *
 * Modeller istenen bicimi cogu zaman tutturur ama her zaman degil: bazen
 * kod blogunu unutur, bazen JSON'un onune arkasina aciklama ekler. Bu yuzden
 * once kod blogu, sonra dengeli parantez taramasi denenir.
 */

function tryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Metindeki ilk dengeli { ... } blogunu bulur (string icindeki suslu parantezleri sayar). */
function balancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson<T>(text: string): T | null {
  // 1) ```json ... ``` blogu
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const m of fenced.reverse()) {
    const parsed = tryParse<T>(m[1].trim());
    if (parsed) return parsed;
  }

  // 2) Tumu zaten JSON olabilir
  const whole = tryParse<T>(text.trim());
  if (whole) return whole;

  // 3) Metnin icine gomulu ilk dengeli nesne
  const obj = balancedObject(text);
  if (obj) {
    const parsed = tryParse<T>(obj);
    if (parsed) return parsed;
  }

  return null;
}
