/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex -- shared localization helpers; dynamic Intl.Segmenter access needs untyped indexing on older lib targets */

/**
 * Locale & i18n helpers for word counting, reading time, dialogue, and prose
 * analysis. Designed to be locale-agnostic via BCP-47 codes and a small
 * per-script profile registry, so adding a new language is normally a
 * single-table change rather than touching every consumer.
 *
 * Inspired by community PR #90 (CJK support), generalised to also cover
 * Latin-script languages (Swedish, Spanish, French, German, Italian,
 * Portuguese, Russian) and other space-less scripts (Thai, Khmer, Lao,
 * Burmese) via the browser's `Intl.Segmenter`.
 */

/**
 * Free-form BCP-47 language tag (`'en'`, `'en-US'`, `'sv'`, `'zh-CN'`,
 * `'ja'`, `'th'`). Stored verbatim in project frontmatter — readers
 * normalise to the base language code via {@link normalizeStoryLineLocale}.
 *
 * Use `'auto'` as a sentinel for "detect from content".
 */
export type StoryLineLocale = string;

export const DEFAULT_STORYLINE_LOCALE: StoryLineLocale = 'en';
export const AUTO_DETECT_LOCALE = 'auto';

/** Writing-system classification used to pick segmentation/wrapping strategy. */
export type ScriptKind = 'latin' | 'cyrillic' | 'cjk' | 'thai' | 'arabic' | 'devanagari';

/**
 * A per-language behaviour profile. Most languages share their script's
 * defaults; only `wpm` / stop-words really differ between e.g. `en` and `sv`.
 */
export interface LocaleProfile {
    /** Base language code (e.g. `'en'`, `'zh'`). */
    code: string;
    /** Human-readable name shown in the settings dropdown. */
    label: string;
    /** Script classification — drives tokenisation strategy. */
    script: ScriptKind;
    /** Words-per-minute for reading-time estimates. */
    wordsPerMinute: number;
    /** Characters-per-minute, used for scriptio-continua scripts (CJK/Thai/…). */
    charactersPerMinute?: number;
    /** Preferred dialogue quote pairs, in detection priority order. */
    dialogueQuotes: ReadonlyArray<readonly [string, string]>;
    /** Regex matching sentence-terminator characters for this language. */
    sentenceTerminators: RegExp;
    /** Common stop words, used for prose-analysis & echo-finder filtering. */
    stopWords: ReadonlySet<string>;
    /** Minimum significant-word length (latin: 3, CJK/Thai: 1). */
    minSignificantLength: number;
    /** Whether `countSyllables` and Flesch-Kincaid are meaningful here. */
    supportsSyllables: boolean;
}

// ── Unicode script ranges ───────────────────────────────

const CJK_RANGE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CJK_RANGE_G = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
const THAI_RANGE = /[\u0E00-\u0E7F]/;
const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const CYRILLIC_RANGE = /[\u0400-\u04FF\u0500-\u052F]/;
const DEVANAGARI_RANGE = /[\u0900-\u097F]/;

const SCRIPTIO_CONTINUA_SCRIPTS = new Set<ScriptKind>(['cjk', 'thai']);

// ── Stop word lists ─────────────────────────────────────
//
// Curated *short* high-frequency lists. Echo-finder uses these to skip
// boilerplate connectives. Extending or replacing per language is a
// non-breaking change.

const STOP_EN = new Set([
    'the', 'and', 'was', 'for', 'that', 'with', 'his', 'her', 'had', 'not', 'but', 'you', 'are',
    'from', 'they', 'she', 'been', 'have', 'him', 'has', 'this', 'were', 'said', 'each', 'its',
    'who', 'which', 'their', 'will', 'would', 'could', 'than', 'them', 'then', 'into', 'more',
    'some', 'when', 'what', 'there', 'about', 'just', 'like', 'all', 'out', 'did', 'one', 'over',
    'how', 'back', 'down', 'only', 'very', 'after', 'before', 'even', 'also', 'other', 'our',
    'own', 'still', 'being', 'your', 'too', 'here', 'those', 'both', 'does', 'where', 'most',
    'much', 'through', 'while', 'now', 'way', 'may', 'any', 'well', 'between', 'another',
    'because', 'such', 'never', 'went', 'came', 'made', 'around', 'long', 'time', 'know',
    'looked', 'thought', 'should', 'going', 'come', 'take', 'make',
]);

const STOP_SV = new Set([
    'och', 'att', 'det', 'en', 'ett', 'som', 'är', 'på', 'för', 'med', 'av', 'inte', 'den',
    'har', 'jag', 'till', 'var', 'om', 'sig', 'men', 'då', 'när', 'från', 'kunde', 'vara',
    'hade', 'vid', 'eller', 'sina', 'sin', 'sitt', 'efter', 'kan', 'skulle', 'man', 'där',
    'hon', 'han', 'dem', 'deras', 'denna', 'detta', 'dessa', 'genom', 'över', 'under',
    'mellan', 'några', 'något', 'någon', 'mycket', 'också', 'nu', 'så', 'bara', 'ändå',
    'redan', 'sedan', 'innan', 'igen', 'varit', 'blev', 'blivit', 'kom', 'såg', 'gick',
    'sade', 'sa', 'tänkte', 'vill', 'måste', 'borde',
]);

const STOP_ES = new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a', 'en',
    'con', 'por', 'para', 'sin', 'sobre', 'entre', 'que', 'y', 'o', 'pero', 'sino', 'si',
    'no', 'es', 'son', 'era', 'eran', 'fue', 'fueron', 'sido', 'ser', 'estar', 'está',
    'están', 'estaba', 'estaban', 'haber', 'ha', 'han', 'había', 'habían', 'su', 'sus',
    'mi', 'tu', 'le', 'les', 'lo', 'me', 'te', 'se', 'nos', 'os', 'él', 'ella', 'ellos',
    'ellas', 'usted', 'cuando', 'donde', 'como', 'porque', 'aunque', 'mientras', 'también',
    'todavía', 'aún', 'ya', 'muy', 'más', 'menos', 'tan', 'tanto', 'casi', 'sólo', 'solo',
    'dijo', 'pensó', 'fue', 'iba', 'vio', 'miró',
]);

const STOP_FR = new Set([
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'à', 'en', 'dans',
    'sur', 'sous', 'avec', 'sans', 'pour', 'par', 'que', 'qui', 'quoi', 'dont', 'où',
    'et', 'ou', 'mais', 'donc', 'or', 'ni', 'car', 'si', 'ne', 'pas', 'plus', 'rien',
    'est', 'sont', 'était', 'étaient', 'été', 'être', 'avoir', 'a', 'ont', 'avait',
    'avaient', 'son', 'sa', 'ses', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'leur',
    'leurs', 'notre', 'nos', 'votre', 'vos', 'il', 'elle', 'ils', 'elles', 'on', 'nous',
    'vous', 'me', 'te', 'se', 'lui', 'eux', 'ce', 'cette', 'ces', 'cet', 'comme',
    'quand', 'comment', 'pourquoi', 'parce', 'aussi', 'encore', 'déjà', 'toujours',
    'jamais', 'puis', 'alors', 'très', 'bien', 'dit', 'pensa', 'vit',
]);

const STOP_DE = new Set([
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
    'eines', 'und', 'oder', 'aber', 'doch', 'denn', 'weil', 'dass', 'daß', 'wenn', 'als',
    'ob', 'wie', 'wo', 'was', 'wer', 'warum', 'nicht', 'kein', 'keine', 'ist', 'sind',
    'war', 'waren', 'gewesen', 'sein', 'haben', 'hat', 'hatte', 'hatten', 'werden',
    'wird', 'wurde', 'wurden', 'sich', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr',
    'mich', 'dich', 'ihn', 'uns', 'euch', 'ihnen', 'mein', 'dein', 'sein', 'ihr',
    'unser', 'euer', 'mit', 'für', 'von', 'zu', 'aus', 'bei', 'nach', 'vor', 'über',
    'unter', 'durch', 'gegen', 'ohne', 'noch', 'schon', 'auch', 'nur', 'sehr', 'mehr',
    'immer', 'wieder', 'sagte', 'dachte', 'sah',
]);

const STOP_IT = new Set([
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'del', 'dello', 'della',
    'dei', 'degli', 'delle', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra',
    'e', 'o', 'ma', 'però', 'se', 'che', 'chi', 'cui', 'come', 'quando', 'dove',
    'perché', 'mentre', 'non', 'è', 'sono', 'era', 'erano', 'stato', 'essere', 'avere',
    'ha', 'hanno', 'aveva', 'avevano', 'suo', 'sua', 'suoi', 'sue', 'mio', 'mia',
    'tuo', 'tua', 'nostro', 'vostro', 'loro', 'lui', 'lei', 'noi', 'voi', 'mi', 'ti',
    'si', 'ci', 'vi', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
    'più', 'meno', 'molto', 'poco', 'già', 'ancora', 'sempre', 'mai', 'anche', 'solo',
    'disse', 'pensò', 'vide',
]);

const STOP_PT = new Set([
    'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
    'no', 'na', 'nos', 'nas', 'em', 'com', 'por', 'para', 'sem', 'sob', 'sobre',
    'entre', 'até', 'que', 'qual', 'quem', 'onde', 'quando', 'como', 'porque', 'e',
    'ou', 'mas', 'porém', 'se', 'não', 'é', 'são', 'era', 'eram', 'foi', 'foram',
    'sido', 'ser', 'estar', 'está', 'estão', 'estava', 'estavam', 'ter', 'tem',
    'têm', 'tinha', 'tinham', 'seu', 'sua', 'seus', 'suas', 'meu', 'minha', 'teu',
    'tua', 'nosso', 'vosso', 'ele', 'ela', 'eles', 'elas', 'nós', 'vós', 'me', 'te',
    'se', 'lhe', 'lhes', 'isto', 'isso', 'aquilo', 'mais', 'menos', 'muito', 'pouco',
    'também', 'já', 'ainda', 'sempre', 'nunca', 'disse', 'pensou', 'viu',
]);

const STOP_RU = new Set([
    'и', 'в', 'не', 'на', 'я', 'что', 'он', 'с', 'как', 'а', 'но', 'это', 'к', 'по',
    'из', 'у', 'за', 'то', 'же', 'от', 'для', 'о', 'бы', 'был', 'была', 'было', 'были',
    'есть', 'быть', 'себя', 'свой', 'свою', 'свои', 'своего', 'своей', 'мой', 'твой',
    'наш', 'ваш', 'его', 'её', 'их', 'мне', 'тебе', 'нам', 'вам', 'им', 'меня',
    'тебя', 'нас', 'вас', 'их', 'когда', 'где', 'куда', 'почему', 'потому', 'если',
    'хотя', 'пока', 'уже', 'ещё', 'еще', 'тоже', 'также', 'очень', 'только', 'даже',
    'между', 'через', 'после', 'перед', 'над', 'под', 'без', 'или', 'либо', 'ни',
    'сказал', 'сказала', 'подумал', 'увидел',
]);

const STOP_ZH = new Set([
    '的', '了', '和', '是', '在', '我', '有', '不', '也', '就', '都', '而', '及', '与', '與',
    '着', '著', '或', '一个', '沒有', '没有', '这', '這', '那', '你', '他', '她', '它',
    '们', '們', '我们', '我們', '你们', '你們', '他们', '他們', '她们', '她們', '这个', '這個',
    '那个', '那個', '这里', '這裡', '那里', '那裡', '什么', '什麼', '这样', '這樣', '这些',
    '這些', '那些', '因为', '因為', '所以', '如果', '但是', '并', '並', '或者', '以及', '对',
    '對', '到', '为', '為', '上', '下', '中', '来', '來', '去', '会', '會', '要', '能', '很',
    '还', '還', '被', '把', '从', '從', '以', '于', '於', '之',
]);

const STOP_JA = new Set([
    'の', 'に', 'は', 'を', 'が', 'と', 'で', 'て', 'た', 'だ', 'です', 'ます', 'いる',
    'ある', 'する', 'ない', 'こと', 'これ', 'それ', 'あれ', 'この', 'その', 'あの',
    'ここ', 'そこ', 'あそこ', '私', '僕', '彼', '彼女', 'もの', 'よう', 'ため', 'から',
    'まで', 'より', 'へ', 'も', 'や', 'か', 'な', 'ね', 'よ', 'ぞ', 'ぜ', 'わ', 'ば',
    'なら', 'そして', 'しかし', 'また', 'もう', 'まだ',
]);

const STOP_KO = new Set([
    '은', '는', '이', '가', '을', '를', '에', '에서', '으로', '로', '와', '과', '하고',
    '도', '만', '의', '에게', '한테', '께', '부터', '까지', '보다', '처럼', '그리고',
    '그러나', '하지만', '또', '더', '나', '너', '그', '그녀', '우리', '저', '것', '수',
    '등', '들', '하다', '있다', '없다', '이다',
]);

const STOP_TH = new Set([
    'และ', 'หรือ', 'แต่', 'ที่', 'ของ', 'ใน', 'กับ', 'จาก', 'ไป', 'มา', 'ได้', 'ไม่',
    'เป็น', 'อยู่', 'มี', 'จะ', 'ก็', 'แล้ว', 'ยัง', 'นี้', 'นั้น', 'เขา', 'เธอ', 'ฉัน',
    'ผม', 'คุณ', 'พวก', 'เรา', 'มัน', 'อะไร', 'ทำไม', 'อย่างไร', 'ที่ไหน',
]);

const STOP_NL = new Set([
    'de', 'het', 'een', 'en', 'of', 'maar', 'want', 'dus', 'als', 'dan', 'toen', 'omdat',
    'dat', 'die', 'dit', 'deze', 'wat', 'wie', 'waar', 'wanneer', 'hoe', 'waarom',
    'in', 'op', 'aan', 'van', 'voor', 'met', 'door', 'over', 'onder', 'tussen', 'naar',
    'bij', 'uit', 'tot', 'om', 'zonder', 'tegen', 'niet', 'geen', 'wel', 'ook', 'nog',
    'al', 'meer', 'zeer', 'erg', 'heel', 'veel', 'weinig', 'altijd', 'nooit', 'soms',
    'is', 'was', 'zijn', 'waren', 'geweest', 'worden', 'wordt', 'werd', 'werden',
    'heeft', 'had', 'hadden', 'hebben', 'kan', 'kon', 'kunnen', 'wil', 'wilde', 'willen',
    'moet', 'moest', 'moeten', 'mag', 'mocht', 'mogen', 'zou', 'zouden', 'gaat', 'ging',
    'ik', 'jij', 'je', 'hij', 'zij', 'ze', 'wij', 'we', 'jullie', 'u', 'mij', 'me',
    'hem', 'haar', 'ons', 'hun', 'zich', 'mijn', 'jouw', 'zijn', 'onze', 'hunne',
    'zei', 'dacht', 'zag', 'keek',
]);

const STOP_PL = new Set([
    'i', 'a', 'o', 'u', 'w', 'we', 'z', 'ze', 'na', 'do', 'po', 'od', 'dla', 'przez',
    'oraz', 'lub', 'albo', 'czy', 'ale', 'lecz', 'jednak', 'więc', 'bo', 'gdyż', 'że',
    'aby', 'żeby', 'jeśli', 'jeżeli', 'gdy', 'kiedy', 'gdzie', 'jak', 'co', 'kto',
    'który', 'która', 'które', 'którzy', 'tego', 'tej', 'tym', 'tych', 'temu', 'ten',
    'ta', 'to', 'ci', 'te', 'taki', 'taka', 'takie', 'jest', 'są', 'był', 'była',
    'było', 'były', 'być', 'będzie', 'będą', 'mam', 'masz', 'ma', 'mamy', 'macie',
    'mają', 'miał', 'miała', 'mieli', 'może', 'można', 'musi', 'powinien', 'ja', 'ty',
    'on', 'ona', 'ono', 'my', 'wy', 'oni', 'one', 'mnie', 'ciebie', 'go', 'jego',
    'jej', 'ich', 'nim', 'nią', 'nich', 'mój', 'twój', 'swój', 'nasz', 'wasz', 'nie',
    'tak', 'już', 'jeszcze', 'tylko', 'też', 'także', 'również', 'bardzo', 'więcej',
    'mniej', 'tutaj', 'tam', 'teraz', 'wtedy', 'powiedział', 'pomyślał', 'spojrzał',
]);

const STOP_NO = new Set([
    'og', 'eller', 'men', 'for', 'så', 'som', 'at', 'om', 'hvis', 'når', 'fordi',
    'mens', 'siden', 'enn', 'hvor', 'hva', 'hvem', 'hvilken', 'hvordan', 'hvorfor',
    'en', 'ei', 'et', 'den', 'det', 'de', 'dem', 'denne', 'dette', 'disse', 'sin',
    'sitt', 'sine', 'min', 'mitt', 'mine', 'din', 'ditt', 'dine', 'vår', 'vårt',
    'våre', 'er', 'var', 'vært', 'være', 'blir', 'ble', 'blitt', 'bli', 'har', 'hadde',
    'ha', 'kan', 'kunne', 'vil', 'ville', 'skal', 'skulle', 'må', 'måtte', 'bør',
    'jeg', 'du', 'han', 'hun', 'vi', 'dere', 'i', 'på', 'av', 'til', 'med', 'fra',
    'under', 'over', 'mellom', 'gjennom', 'mot', 'uten', 'etter', 'før', 'ved', 'hos',
    'ikke', 'ingen', 'noe', 'noen', 'alt', 'alle', 'mye', 'lite', 'mer', 'mindre',
    'her', 'der', 'nå', 'da', 'allerede', 'enda', 'fortsatt', 'aldri', 'alltid', 'ofte',
    'bare', 'også', 'kun', 'sa', 'sa', 'tenkte', 'så',
]);

const STOP_DA = new Set([
    'og', 'eller', 'men', 'for', 'så', 'som', 'at', 'om', 'hvis', 'når', 'fordi',
    'mens', 'siden', 'end', 'hvor', 'hvad', 'hvem', 'hvilken', 'hvordan', 'hvorfor',
    'en', 'et', 'den', 'det', 'de', 'dem', 'denne', 'dette', 'disse', 'sin', 'sit',
    'sine', 'min', 'mit', 'mine', 'din', 'dit', 'dine', 'vor', 'vort', 'vores',
    'er', 'var', 'været', 'være', 'blive', 'bliver', 'blev', 'har', 'havde', 'have',
    'kan', 'kunne', 'vil', 'ville', 'skal', 'skulle', 'må', 'måtte', 'bør',
    'jeg', 'du', 'han', 'hun', 'vi', 'I', 'mig', 'dig', 'ham', 'hende', 'os', 'jer',
    'i', 'på', 'af', 'til', 'med', 'fra', 'under', 'over', 'mellem', 'gennem', 'mod',
    'uden', 'efter', 'før', 'ved', 'hos', 'ikke', 'ingen', 'noget', 'nogen', 'alt',
    'alle', 'meget', 'lidt', 'mere', 'mindre', 'her', 'der', 'nu', 'da', 'allerede',
    'endnu', 'stadig', 'aldrig', 'altid', 'ofte', 'kun', 'også', 'sagde', 'tænkte',
]);

const STOP_FI = new Set([
    'ja', 'tai', 'mutta', 'vaan', 'sekä', 'eli', 'että', 'jos', 'kun', 'koska',
    'vaikka', 'kuin', 'mikä', 'mitä', 'kuka', 'kenen', 'missä', 'milloin', 'miten',
    'miksi', 'minä', 'sinä', 'hän', 'me', 'te', 'he', 'minun', 'sinun', 'hänen',
    'meidän', 'teidän', 'heidän', 'tämä', 'tuo', 'se', 'nämä', 'nuo', 'ne', 'tällä',
    'sillä', 'nyt', 'sitten', 'jo', 'vielä', 'aina', 'koskaan', 'usein', 'joskus',
    'on', 'oli', 'ollut', 'olla', 'olisi', 'ovat', 'olivat', 'olleet', 'tulee', 'tuli',
    'voi', 'voisi', 'pitää', 'täytyy', 'saa', 'saisi', 'ei', 'eikä', 'en', 'et',
    'emme', 'ette', 'eivät', 'in', 'oma', 'omat', 'kaikki', 'jokainen', 'joku',
    'jotain', 'mitään', 'paljon', 'vähän', 'enemmän', 'vähemmän', 'hyvin', 'erittäin',
    'sanoi', 'ajatteli', 'näki', 'katsoi',
]);

// ── Profile registry ────────────────────────────────────

const LATIN_SENTENCE_RE = /[.!?]+/;
const CJK_SENTENCE_RE = /[.!?。！？]+/;
const THAI_SENTENCE_RE = /[.!?ฯ]+|\s{2,}/;
const ARABIC_SENTENCE_RE = /[.!?؟]+/;

const LATIN_QUOTES: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'], ['\u201c', '\u201d'], ['\u00ab', '\u00bb'],
];
const CJK_ZH_QUOTES: ReadonlyArray<readonly [string, string]> = [
    ['\u201c', '\u201d'], ['\u300c', '\u300d'], ['\u300e', '\u300f'], ['"', '"'],
];
const CJK_JA_QUOTES: ReadonlyArray<readonly [string, string]> = [
    ['\u300c', '\u300d'], ['\u300e', '\u300f'], ['\u201c', '\u201d'], ['"', '"'],
];

const PROFILES: Record<string, LocaleProfile> = {
    en: { code: 'en', label: 'English', script: 'latin', wordsPerMinute: 250, dialogueQuotes: LATIN_QUOTES, sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_EN, minSignificantLength: 3, supportsSyllables: true },
    sv: { code: 'sv', label: 'Svenska', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['"', '"'], ['\u201d', '\u201d'], ['\u201c', '\u201d']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_SV, minSignificantLength: 3, supportsSyllables: false },
    es: { code: 'es', label: 'Español', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u00ab', '\u00bb'], ['\u2014', '\u2014'], ['"', '"'], ['\u201c', '\u201d']], sentenceTerminators: /[.!?¡¿]+/, stopWords: STOP_ES, minSignificantLength: 3, supportsSyllables: false },
    fr: { code: 'fr', label: 'Français', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u00ab', '\u00bb'], ['\u2014', '\u2014'], ['"', '"']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_FR, minSignificantLength: 3, supportsSyllables: false },
    de: { code: 'de', label: 'Deutsch', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u201e', '\u201c'], ['\u00bb', '\u00ab'], ['"', '"']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_DE, minSignificantLength: 3, supportsSyllables: false },
    it: { code: 'it', label: 'Italiano', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u00ab', '\u00bb'], ['\u201c', '\u201d'], ['"', '"']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_IT, minSignificantLength: 3, supportsSyllables: false },
    pt: { code: 'pt', label: 'Português', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u201c', '\u201d'], ['"', '"'], ['\u00ab', '\u00bb']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_PT, minSignificantLength: 3, supportsSyllables: false },
    ru: { code: 'ru', label: 'Русский', script: 'cyrillic', wordsPerMinute: 180, dialogueQuotes: [['\u00ab', '\u00bb'], ['\u201e', '\u201c'], ['"', '"']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_RU, minSignificantLength: 3, supportsSyllables: false },
    nl: { code: 'nl', label: 'Nederlands', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u201c', '\u201d'], ['"', '"'], ['\u201a', '\u2018']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_NL, minSignificantLength: 3, supportsSyllables: false },
    pl: { code: 'pl', label: 'Polski', script: 'latin', wordsPerMinute: 200, dialogueQuotes: [['\u201e', '\u201d'], ['\u00ab', '\u00bb'], ['"', '"']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_PL, minSignificantLength: 3, supportsSyllables: false },
    no: { code: 'no', label: 'Norsk', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u00ab', '\u00bb'], ['\u201c', '\u201d'], ['"', '"']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_NO, minSignificantLength: 3, supportsSyllables: false },
    da: { code: 'da', label: 'Dansk', script: 'latin', wordsPerMinute: 220, dialogueQuotes: [['\u00bb', '\u00ab'], ['\u201d', '\u201d'], ['"', '"']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_DA, minSignificantLength: 3, supportsSyllables: false },
    fi: { code: 'fi', label: 'Suomi', script: 'latin', wordsPerMinute: 200, dialogueQuotes: [['\u201d', '\u201d'], ['"', '"'], ['\u00bb', '\u00bb']], sentenceTerminators: LATIN_SENTENCE_RE, stopWords: STOP_FI, minSignificantLength: 3, supportsSyllables: false },
    zh: { code: 'zh', label: '中文 (Chinese)', script: 'cjk', wordsPerMinute: 160, charactersPerMinute: 260, dialogueQuotes: CJK_ZH_QUOTES, sentenceTerminators: CJK_SENTENCE_RE, stopWords: STOP_ZH, minSignificantLength: 1, supportsSyllables: false },
    ja: { code: 'ja', label: '日本語 (Japanese)', script: 'cjk', wordsPerMinute: 190, charactersPerMinute: 360, dialogueQuotes: CJK_JA_QUOTES, sentenceTerminators: CJK_SENTENCE_RE, stopWords: STOP_JA, minSignificantLength: 1, supportsSyllables: false },
    ko: { code: 'ko', label: '한국어 (Korean)', script: 'cjk', wordsPerMinute: 250, charactersPerMinute: 500, dialogueQuotes: CJK_ZH_QUOTES, sentenceTerminators: CJK_SENTENCE_RE, stopWords: STOP_KO, minSignificantLength: 1, supportsSyllables: false },
    th: { code: 'th', label: 'ไทย (Thai)', script: 'thai', wordsPerMinute: 200, charactersPerMinute: 300, dialogueQuotes: LATIN_QUOTES, sentenceTerminators: THAI_SENTENCE_RE, stopWords: STOP_TH, minSignificantLength: 1, supportsSyllables: false },
    ar: { code: 'ar', label: 'العربية (Arabic)', script: 'arabic', wordsPerMinute: 180, dialogueQuotes: [['\u00ab', '\u00bb'], ['"', '"']], sentenceTerminators: ARABIC_SENTENCE_RE, stopWords: new Set<string>(), minSignificantLength: 2, supportsSyllables: false },
    he: { code: 'he', label: 'עברית (Hebrew)', script: 'arabic', wordsPerMinute: 180, dialogueQuotes: LATIN_QUOTES, sentenceTerminators: LATIN_SENTENCE_RE, stopWords: new Set<string>(), minSignificantLength: 2, supportsSyllables: false },
    hi: { code: 'hi', label: 'हिन्दी (Hindi)', script: 'devanagari', wordsPerMinute: 200, dialogueQuotes: LATIN_QUOTES, sentenceTerminators: /[.!?।]+/, stopWords: new Set<string>(), minSignificantLength: 2, supportsSyllables: false },
};

/** List of locales offered in the Settings UI. */
export const SUPPORTED_STORYLINE_LOCALES: ReadonlyArray<{ code: string; label: string }> =
    Object.values(PROFILES).map(p => ({ code: p.code, label: p.label }));

// ── Public helpers ──────────────────────────────────────

/**
 * Strip region tags + casing variations from a BCP-47 value and return the
 * base language code if it's known to us, else the original normalised tag
 * (or `DEFAULT_STORYLINE_LOCALE` when blank).
 */
export function normalizeStoryLineLocale(value: unknown): StoryLineLocale {
    const raw = String(value ?? '').trim().toLowerCase().replace('_', '-');
    if (!raw) return DEFAULT_STORYLINE_LOCALE;
    if (raw === AUTO_DETECT_LOCALE) return AUTO_DETECT_LOCALE;
    const base = raw.split('-')[0];
    return PROFILES[base] ? base : (PROFILES[raw] ? raw : (base || DEFAULT_STORYLINE_LOCALE));
}

/** Resolve a profile, falling back to English if unknown. */
export function getLocaleProfile(locale: StoryLineLocale): LocaleProfile {
    const base = String(locale || '').toLowerCase().split('-')[0];
    return PROFILES[base] ?? PROFILES.en;
}

export function isScriptioContinuaLocale(locale: StoryLineLocale): boolean {
    return SCRIPTIO_CONTINUA_SCRIPTS.has(getLocaleProfile(locale).script);
}

/** Back-compat alias matching PR #90's nomenclature. */
export function isCjkStoryLineLocale(locale: StoryLineLocale): boolean {
    return getLocaleProfile(locale).script === 'cjk';
}

export function hasCjkCharacters(text: string): boolean {
    return CJK_RANGE.test(text);
}

export function countReadingCharacters(text: string): number {
    return (text.match(CJK_RANGE_G) || []).length;
}

export function getReadingWordsPerMinute(locale: StoryLineLocale): number {
    return getLocaleProfile(locale).wordsPerMinute;
}

export function getReadingCharactersPerMinute(locale: StoryLineLocale): number {
    return getLocaleProfile(locale).charactersPerMinute ?? 0;
}

export function getDialogueQuotePairs(locale: StoryLineLocale): ReadonlyArray<readonly [string, string]> {
    return getLocaleProfile(locale).dialogueQuotes;
}

export function getStopWords(locale: StoryLineLocale): ReadonlySet<string> {
    return getLocaleProfile(locale).stopWords;
}

/** Heuristic: detect locale from the dominant script in `text`. */
export function detectLocaleFromText(text: string, fallback: StoryLineLocale = DEFAULT_STORYLINE_LOCALE): StoryLineLocale {
    if (!text) return fallback;
    const sample = text.length > 4000 ? text.slice(0, 4000) : text;
    const cjk = (sample.match(CJK_RANGE_G) || []).length;
    const thai = (sample.match(new RegExp(THAI_RANGE.source, 'g')) || []).length;
    const arabic = (sample.match(new RegExp(ARABIC_RANGE.source, 'g')) || []).length;
    const cyrillic = (sample.match(new RegExp(CYRILLIC_RANGE.source, 'g')) || []).length;
    const devanagari = (sample.match(new RegExp(DEVANAGARI_RANGE.source, 'g')) || []).length;
    const latin = (sample.match(/[A-Za-z]/g) || []).length;

    const max = Math.max(cjk, thai, arabic, cyrillic, devanagari, latin);
    if (max < 20) return fallback;
    if (max === cjk) {
        // Disambiguate zh / ja / ko by character ranges.
        if (/[\u3040-\u309F\u30A0-\u30FF]/.test(sample)) return 'ja';
        if (/[\uAC00-\uD7AF]/.test(sample)) return 'ko';
        return 'zh';
    }
    if (max === thai) return 'th';
    if (max === arabic) return 'ar';
    if (max === cyrillic) return 'ru';
    if (max === devanagari) return 'hi';
    return fallback;
}

/** Resolve a stored locale value, optionally auto-detecting from sample text. */
export function resolveLocale(stored: unknown, sampleText?: string, fallback: StoryLineLocale = DEFAULT_STORYLINE_LOCALE): StoryLineLocale {
    const norm = normalizeStoryLineLocale(stored);
    if (norm === AUTO_DETECT_LOCALE) {
        return sampleText ? detectLocaleFromText(sampleText, fallback) : fallback;
    }
    return norm;
}

// ── Segmentation ────────────────────────────────────────

interface SegmenterCtor {
    new (locale?: string, options?: { granularity: 'word' | 'sentence' | 'grapheme' }): {
        segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
    };
}

function getSegmenter(locale: string, granularity: 'word' | 'sentence' | 'grapheme' = 'word') {
    const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    if (!ctor) return null;
    try { return new ctor(locale, { granularity }); } catch { return null; }
}

/**
 * Split `text` into word-like tokens for word counts and analysis. Uses
 * `Intl.Segmenter` for scripts without explicit word delimiters (CJK, Thai)
 * and a whitespace split otherwise.
 */
export function tokenizeWords(text: string, locale: StoryLineLocale = DEFAULT_STORYLINE_LOCALE): string[] {
    if (!text) return [];
    const profile = getLocaleProfile(locale);

    if (!SCRIPTIO_CONTINUA_SCRIPTS.has(profile.script)) {
        return text.split(/\s+/).filter(w => w.length > 0);
    }

    const seg = getSegmenter(profile.code, 'word');
    if (seg) {
        return Array.from(seg.segment(text))
            .filter(part => part.isWordLike === true)
            .map(part => part.segment.trim())
            .filter(Boolean);
    }

    // Fallback: each CJK codepoint = 1 token; ASCII words bunched together.
    return text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g) || [];
}

/** Split text into sentences using the locale's terminator set. */
export function splitSentences(text: string, locale: StoryLineLocale = DEFAULT_STORYLINE_LOCALE): string[] {
    if (!text) return [];
    const re = getLocaleProfile(locale).sentenceTerminators;
    return text.split(re).map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Token list for PDF line wrapping. Breaks CJK on individual codepoints so
 * lines wrap inside a paragraph of Chinese/Japanese rather than overflowing
 * the page width.
 */
export function splitWrapTokens(text: string): string[] {
    return text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|\s+|[^\s\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]+/g) || [];
}

export function isCjkWrapToken(text: string): boolean {
    return CJK_RANGE.test(text);
}

// ── Dialogue ────────────────────────────────────────────

/** Sum character counts of all balanced dialogue quote pairs in `text`. */
export function countDialogueCharacters(text: string, locale: StoryLineLocale = DEFAULT_STORYLINE_LOCALE): number {
    let total = 0;
    for (const [open, close] of getDialogueQuotePairs(locale)) {
        if (!open || !close) continue;
        let start = 0;
        // Same-character pairs (like `"`) need a different walk so we don't
        // pair an opener with itself; toggle every match instead.
        if (open === close) {
            const positions: number[] = [];
            let i = text.indexOf(open);
            while (i >= 0) { positions.push(i); i = text.indexOf(open, i + open.length); }
            for (let k = 0; k + 1 < positions.length; k += 2) {
                total += Math.max(0, positions[k + 1] - (positions[k] + open.length));
            }
            continue;
        }
        while (start < text.length) {
            const openAt = text.indexOf(open, start);
            if (openAt < 0) break;
            const contentStart = openAt + open.length;
            const closeAt = text.indexOf(close, contentStart);
            if (closeAt < 0) break;
            total += Math.max(0, closeAt - contentStart);
            start = closeAt + close.length;
        }
    }
    return total;
}

// ── Prose analysis helpers ──────────────────────────────

/** Strip leading/trailing non-letters; pass-through for non-Latin scripts. */
export function normalizeAnalysisToken(word: string, locale: StoryLineLocale): string {
    const profile = getLocaleProfile(locale);
    if (profile.script === 'latin') {
        return word.replace(/^[^a-z\u00c0-\u017f]+|[^a-z\u00c0-\u017f]+$/gi, '');
    }
    return word.trim();
}

export function isSignificantWord(word: string, locale: StoryLineLocale, stopWords: ReadonlySet<string> = getStopWords(locale)): boolean {
    const w = normalizeAnalysisToken(word, locale);
    if (!w) return false;
    if (stopWords.has(w)) return false;
    return w.length >= getLocaleProfile(locale).minSignificantLength;
}

/** Whether `countSyllables` / Flesch metrics make sense for this locale. */
export function supportsSyllableMetrics(locale: StoryLineLocale): boolean {
    return getLocaleProfile(locale).supportsSyllables;
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex -- end of file-wide suppression block */
