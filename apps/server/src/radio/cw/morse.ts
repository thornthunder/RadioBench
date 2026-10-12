/** The International Morse code, by its dots and dashes. Prosigns are written in angle brackets. */
export const MORSE: Readonly<Record<string, string>> = {
  '.-': 'A',
  '-...': 'B',
  '-.-.': 'C',
  '-..': 'D',
  '.': 'E',
  '..-.': 'F',
  '--.': 'G',
  '....': 'H',
  '..': 'I',
  '.---': 'J',
  '-.-': 'K',
  '.-..': 'L',
  '--': 'M',
  '-.': 'N',
  '---': 'O',
  '.--.': 'P',
  '--.-': 'Q',
  '.-.': 'R',
  '...': 'S',
  '-': 'T',
  '..-': 'U',
  '...-': 'V',
  '.--': 'W',
  '-..-': 'X',
  '-.--': 'Y',
  '--..': 'Z',
  '-----': '0',
  '.----': '1',
  '..---': '2',
  '...--': '3',
  '....-': '4',
  '.....': '5',
  '-....': '6',
  '--...': '7',
  '---..': '8',
  '----.': '9',
  '.-.-.-': '.',
  '--..--': ',',
  '..--..': '?',
  '.----.': "'",
  '-.-.--': '!',
  '-..-.': '/',
  '-.--.': '(',
  '-.--.-': ')',
  '---...': ':',
  '-.-.-.': ';',
  '-...-': '=',
  '.-.-.': '+',
  '-....-': '-',
  '..--.-': '_',
  '.-..-.': '"',
  '...-..-': '$',
  '.--.-.': '@',
  '...-.-': '<SK>',
  '.-...': '<AS>',
  '-...-.-': '<BK>',
  '........': '<HH>',
};

/** The code for each character, for sending. */
export const CODE_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(MORSE).map(([code, text]) => [text, code]),
);

/** One stretch of keying: the tone on or off for so many dit lengths. */
export interface KeyingElement {
  on: boolean;
  dits: number;
}

/**
 * The keying of a text in standard timing: a dah is three dits, the gaps within a character
 * one dit, between characters three, between words seven. Prosigns may be given in angle
 * brackets; characters the code lacks are skipped.
 */
export function keying(text: string): KeyingElement[] {
  const elements: KeyingElement[] = [];
  const words = text.toUpperCase().trim().split(/\s+/);
  words.forEach((word, wordIndex) => {
    if (wordIndex > 0) elements.push({ on: false, dits: 7 });
    const characters = word.match(/<[A-Z]+>|./g) ?? [];
    let first = true;
    for (const character of characters) {
      const code = CODE_OF.get(character);
      if (!code) continue;
      if (!first) elements.push({ on: false, dits: 3 });
      first = false;
      [...code].forEach((mark, index) => {
        if (index > 0) elements.push({ on: false, dits: 1 });
        elements.push({ on: true, dits: mark === '-' ? 3 : 1 });
      });
    }
  });
  return elements;
}

/** The length of a dit at a speed in words per minute, by the PARIS standard. */
export function ditMs(wpm: number): number {
  return 1200 / wpm;
}
