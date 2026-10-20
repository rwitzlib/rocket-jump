// Keeping names and chat civil: a small word filter (with the usual letter-for-number dodges
// undone), and the rules for kicking someone by vote. The server applies both; the word list is
// short on purpose, aimed at slurs and the worst of the rest rather than every rude word.

// Stored lightly scrambled (each word reversed) so the source doesn't read as a list of slurs.
// ANYWHERE words are caught inside longer ones ("xXfuckXx"); WHOLE ones only on their own, since
// they turn up inside innocent words too ("spicy", "Gooker"). The cost: Scunthorpe.
const unscramble = (words: string[]) => words.map((w) => [...w].reverse().join(''));
const ANYWHERE = unscramble(['reggin', 'aggin', 'ggin', 'toggaf', 'ggaf', 'knihc', 'drater', 'tsipar', 'kcuf', 'tnuc', 'tihs', 'hctib', 'erohw']);
const WHOLE = unscramble(['cips', 'koog', 'ekik', 'tuls', 'yssup', 'gaf', 'ggin']);

/** Folds the common dodges (n1gg3r, f.u.c.k, sh!t) back to plain letters. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0@4]/g, (c) => (c === '0' ? 'o' : 'a'))
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/9/g, 'g');
}

const letters = (text: string) => fold(text).replace(/[^a-z]/g, '');
const SUFFIXES = ['', 's', 'z', 'es'];
const wholeMatch = (token: string) => WHOLE.some((w) => SUFFIXES.some((s) => token === w + s));

/** Whether a name has anything from the list in it, however it's spelled or spaced. */
export function isOffensive(text: string): boolean {
  const flat = letters(text);
  if (ANYWHERE.some((w) => flat.includes(w))) return true;
  // Words on their own: split at spaces and symbols, and at camel case ("BigSpic").
  const tokens = text.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9@$!|]+/).map(letters);
  return tokens.some(wholeMatch);
}

/** Chat with listed words starred out, one word at a time. */
export function maskChat(text: string): string {
  return text.replace(/\S+/g, (word) => (isOffensive(word) ? word[0] + '*'.repeat(Math.max(1, word.length - 1)) : word));
}

/** Vote kicks: how long one runs, how often one person can start one, and how long the kicked stay out. */
export const VOTE_KICK = {
  duration: 30, // seconds to gather votes
  cooldown: 60, // seconds before the same person can call another
  ban: 10 * 60, // seconds a kicked player is kept out of that room
  minVoters: 2, // people besides the target who must be there for a vote to make sense
};

/** A vote passes once more than half of those who can vote (everyone but the target) say yes. */
export function votePasses(yes: number, voters: number): boolean {
  return voters >= VOTE_KICK.minVoters && yes * 2 > voters;
}
