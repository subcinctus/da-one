// Rule data for tells.mjs: words, phrases and openers that make prose read as AI-written.
// Patterns are ported and adapted (selected, merged into regexes, re-weighted, new messages) from
// these MIT-licensed projects:
//   - blader/humanizer, SKILL.md v3.1.0, (c) 2025 Siqi Chen: the 26 patterns of AI writing
//     (itself based on Wikipedia's "Signs of AI writing"); github.com/blader/humanizer
//   - tbhb/vale-ai-tells, styles/ai-tells/*.yml, (c) 2025-2026 Tony Burns: OverusedVocabulary,
//     AICompoundPhrases, OpeningCliches, ConclusionMarkers, FormalTransitions, HedgingPhrases,
//     StackedHedges, ContrastiveFormulas, ParticipialPadding, ServesAsDodge, UrgencyInflation,
//     PromotionalPuffery, VagueAttributions, ClosingPleasantries, SycophancyMarkers, UnpackExplore,
//     AffirmativeFormulas, DespiteChallenges; github.com/tbhb/vale-ai-tells
//   - hardikpandya/stop-slop, references/phrases.md and structures.md, (c) 2025 Hardik Pandya;
//     github.com/hardikpandya/stop-slop
//   - berenslab/llm-excess-vocab, results/excess_words.csv and yearly-counts.csv.gz, (c) 2024 Dmitry
//     Kobak, Rita González-Márquez: style words only; weights follow each word's 2024 excess ratio
//     in PubMed abstracts (3: r > 5, 2: r 2.5-5, 1: weaker or common in business prose)
//   - pablocaeg/sloptotal, app/engines/structural.py, (c) 2025-2026 SlopTotal: em-dash rate,
//     sentence-length CV and "Label: Explanation" colon lines (used in tells.mjs)
// Tuned for formal Indian finance writing: plain formality is not a tell, so domain and register
// words (implement, prioritise, optimise, facilitate, utilisation, robust, comprehensive, significant,
// leverage as a noun, endeavour, aforementioned…) are deliberately absent. See DOMAIN_SAFE.
// Weights: 3 = act on one sighting, 2 = clear tell, 1 = weak alone (needs company).

// [space-separated forms, weight, what to do instead]
export const AI_WORDS = [
  ['delve delves delved delving', 3, 'Use "look at", or just say it.'],
  ['underscore underscores underscored underscoring', 3, 'Use "shows" or "stresses".'],
  ['showcase showcases showcased showcasing', 3, 'Use "show".'],
  ['meticulous meticulously', 3, 'Use "careful", or show the care.'],
  ['tapestry tapestries', 3, 'Drop the metaphor.'],
  ['intricate intricately intricacies', 2, 'Use "complex" or name the detail.'],
  ['testament', 2, 'Use "shows" or "proof".'],
  ['pivotal', 2, 'Say what it changes.'],
  ['seamless seamlessly', 2, 'Cut it, or say what is smooth.'],
  ['holistic holistically', 2, 'Say what it covers.'],
  ['multifaceted', 2, 'Name the parts.'],
  ['transformative', 2, 'Say what changed.'],
  ['groundbreaking', 2, 'Use "new", or give the fact.'],
  ['unparalleled', 2, 'Give the comparison.'],
  ['commendable', 2, 'Use "good", or say why.'],
  ['realm realms', 2, 'Use "area" or "field".'],
  ['embark embarks embarked embarking', 2, 'Use "start".'],
  ['garner garners garnered garnering', 2, 'Use "win" or "get".'],
  ['unwavering', 2, 'Cut it, or give the evidence.'],
  ['paramount', 2, 'Use "most important".'],
  ['myriad plethora', 2, 'Use "many", or give the number.'],
  ['burgeoning', 2, 'Use "growing".'],
  ['ever-evolving ever-changing', 2, 'Cut it.'],
  ['game-changer game-changers game-changing', 2, 'Say what changed.'],
  ['elevate elevates elevating', 2, 'Use "raise" or "improve".'],
  ['foster fosters fostered fostering', 2, 'Use "build" or "encourage".'],
  ['harness harnesses harnessed harnessing', 2, 'Use "use".'],
  ['leveraging leverages', 2, 'Use "using" or "uses".'],
  ['interplay', 2, 'Say how one affects the other.'],
  ['vibrant bustling', 2, 'Cut it.'],
  ['nestled', 2, 'Use "is in".'],
  ['spearhead spearheads spearheaded spearheading', 2, 'Use "lead".'],
  ['revolutionize revolutionise revolutionizes revolutionises revolutionizing revolutionising', 2, 'Say what changed.'],
  ['resonate resonates resonating', 2, 'Say who responds and how.'],
  ['impactful', 2, 'Say what the effect is.'],
  ['elucidate elucidates elucidating', 2, 'Use "explain".'],
  ['crucial crucially vital', 1, 'Say why it matters, or use "important".'],
  ['notable notably noteworthy', 1, 'Cut it, or give the number.'],
  ['additionally', 1, 'Use "also".'],
  ['proactive proactively', 1, 'Say what you do early.'],
  ['navigate navigates navigated navigating', 1, 'Use "handle" or "manage".'],
  ['landscape landscapes', 1, 'Name the market or the rules.'],
  ['dynamic', 1, 'Cut it.'],
  ['enhancing', 1, 'Use "improving".'],
  ['bolster bolsters bolstered bolstering', 1, 'Use "strengthen" or "support".'],
  ['empower empowers empowering', 1, 'Say what people can now do.'],
  ['streamline streamlines streamlined streamlining', 1, 'Use "simplify", and say how.'],
  ['nuanced', 1, 'Give the detail.'],
  ['encompass encompasses encompassing', 1, 'Use "cover" or "include".'],
  ['renowned', 1, 'Give the evidence.'],
  ['enduring', 1, 'Cut it, or say how long.'],
  ['innovative pioneering cutting-edge', 1, 'Say what is new.'],
  ['state-of-the-art best-in-class world-class', 1, 'Give the comparison, or cut it.'],
  ['insightful invaluable', 1, 'Say what the reader learns.'],
  ['exemplify exemplifies exemplifying', 1, 'Use "shows".'],
  ['actionable', 1, 'Say what to do.'],
  ['fast-paced', 1, 'Cut it.'],
];

// A capitalised AI word mid-sentence is a name ("Vibrant Gujarat"), not a tell. Some words are
// fine before certain nouns: banking terms such as dynamic provisioning.
export const WORD_EXCEPTIONS = {
  dynamic: /^\s+(?:provisioning|pricing|rates?|duration|asset allocation|hedging|programming)\b/i,
  landscape: /^\s+(?:architect|design|photograph)/i,
};

// "leverage" is a balance-sheet noun in finance; flag it only as a verb after these words.
export const LEVERAGE_VERB = /\b(?:to|will|can|could|should|must|may|might|we|they|you|i|us|let['’]s|would|shall|also) (leverage)\b(?! ratios?\b| multiples?\b| levels?\b| position\b| of\b| at\b| on\b| is\b| was\b| has\b| remains?\b)/gi;

// Phrases flagged anywhere: [regex, rule, category, weight, message]. Weight may be a function of
// the match. Keep each regex bounded (no unbounded nested repeats) so a 1,000-word answer stays fast.
export const PHRASES = [
  [/\bin today['’]s (?:[\w-]+ ){0,3}?(world|landscape|era|age|environment|market|marketplace|economy|climate|scenario|times|ecosystem|context)\b/gi,
    'todays-world', 'opener', (m) => (/^(?:world|landscape|era|age)$/i.test(m[1]) ? 3 : m[0].split(/\s+/).length > 3 ? 2 : 0),
    'Stock opener. Start with your point.'],
  [/\bin (?:an|the) (?:ever[- ]evolving|rapidly evolving|ever[- ]changing|fast[- ]paced|dynamic|increasingly [\w-]+) (?:world|landscape|era|environment|market|economy|realm|space)\b/gi,
    'era-opener', 'opener', 2, 'Stock scene-setter. Start with your point.'],
  [/\bin an (?:era|age) (?:of|where|when|defined by|marked by)\b/gi, 'era-opener', 'opener', 2, 'Stock scene-setter. Start with your point.'],
  [/\bin this day and age\b|\bgone are the days\b|\bpicture this\b|\bimagine a world\b|\bwithout further ado\b/gi,
    'era-opener', 'opener', 2, 'Stock scene-setter. Start with your point.'],
  [/\bin the (?:realm|world) of\b/gi, 'realm-of', 'phrase', 1, 'Filler frame. Name the subject directly.'],
  [/\bplay(?:s|ed|ing)? (?:a|an) (?:[\w-]+ )?(?:pivotal|crucial|key|vital|critical|central|significant|instrumental|important|major|integral|decisive|fundamental|essential) role\b/gi,
    'plays-role', 'phrase', 2, 'Stock phrase. Say what it does.'],
  [/\b(?:first and foremost|last but not least)\b/gi, 'first-foremost', 'phrase', 2, 'Filler. Start with the point.'],
  [/\bit(?: is|['’]s) (important|essential|crucial|critical|imperative|vital|worth)(?: (?:for [\w-]+(?: [\w-]+)? )?to)?(?: (note|noting|mention|mentioning|highlight|highlighting|emphasi[sz]e|remember|recogni[sz]e|understand|acknowledge|consider|stress|point out))?(?: that)?\b/gi,
    'important-to', 'phrase', (m) => (m[2] ? 2 : /worth/i.test(m[1]) ? 0 : 1), 'Throat-clearing. State the point or the action.'],
  [/\bworth (?:noting|mentioning|highlighting)\b|\bit goes without saying\b|\bneedless to say\b|\bit should be (?:noted|emphasi[sz]ed|highlighted) that\b/gi,
    'important-to', 'phrase', 2, 'Throat-clearing. State the point.'],
  [/\b(?:that being said|with that (?:being )?said)\b/gi, 'that-said', 'phrase', 1, 'Filler link. Cut it.'],
  [/\b(?:a|an|the) testament to\b|\b(?:stands|stood|standing) as (?:a|an|the)\b/gi, 'testament', 'phrase', 2, 'Inflated. Say what it shows.'],
  [/\b(?:serves?|served|serving|acts?|acted|acting) as (?:a|an|the) (?:[\w-]+ )?(?:reminder|testament|cornerstone|catalyst|beacon|bridge|springboard|blueprint|bulwark|hallmark|linchpin|backbone)\b/gi,
    'serves-as', 'phrase', 2, 'Inflated "serves as". Use "is", or say what it does.'],
  [/\b(?:a|the) (?:cornerstone|linchpin|bedrock|hallmark) of\b/gi, 'serves-as', 'phrase', 1, 'Inflated metaphor. Say what it does.'],
  [/\bpav(?:e|es|ed|ing) the way\b|\bset(?:s|ting)? the stage\b|\blay(?:s|ing)? the groundwork\b|\blaid the groundwork\b/gi,
    'paves-way', 'phrase', 2, 'Inflated significance. Say what happens next.'],
  [/\b(?:marks?|marked|marking|represents?|represented|representing) (?:a|an) (pivotal|significant|major|crucial|key|defining|turning|watershed|new) (?:moment|milestone|step|shift|turning point|chapter|era|juncture)\b/gi,
    'marks-moment', 'phrase', (m) => (/pivotal|defining|watershed|turning/i.test(m[1]) ? 2 : 1), 'Inflated significance. Give the fact.'],
  [/\b(?:indelible|lasting|enduring) (?:mark|legacy|imprint)\b/gi, 'marks-moment', 'phrase', 2, 'Inflated significance. Give the fact.'],
  [/\bunlock(?:s|ed|ing)? (?:the |its |their |our |your |new )?(?:full |true )?(?:potential|value|possibilities|opportunities|growth)\b/gi,
    'unlock-potential', 'phrase', 2, 'Stock phrase. Say what you will do and the result.'],
  [/\bharness(?:es|ed|ing)? the (?:full )?power of\b|\bthe transformative power of\b/gi, 'unlock-potential', 'phrase', 2, 'Stock phrase. Say what you use and for what.'],
  [/\bnavigat(?:e|es|ed|ing) (?:the |these |its |their |this )?(?:[\w-]+ )?(?:complexities|complexity|challenges|intricacies|landscape|nuances|waters|maze|uncertaint(?:y|ies))\b/gi,
    'navigate-complexities', 'phrase', 2, 'Stock phrase. Name the problem and what you do about it.'],
  [/\b(?:a )?deep dive\b|\bdiv(?:e|es|ing) (?:deep |deeper )?into\b|\bdelv(?:e|es|ing) (?:deep |deeper )?into\b/gi, 'deep-dive', 'phrase', 2, 'Stock phrase. Use "look at", or just say it.'],
  [/\bembark(?:s|ed|ing)? on (?:a|an|the|this|our|their) (?:[\w-]+ )?journey\b/gi, 'journey', 'phrase', 2, 'Journey metaphor. Say what you are starting.'],
  [/\b(?:intricate|delicate|dynamic|complex) (?:interplay|balance|dance)\b/gi, 'interplay', 'phrase', 2, 'Stock phrase. Say how the two affect each other.'],
  [/\b(?:rich|intricate|vibrant|diverse) tapestry\b|\btapestry of\b/gi, 'tapestry', 'phrase', 3, 'AI metaphor. Drop it.'],
  [/\b(?:game[- ]chang(?:er|ers|ing)|paradigm shift|double-edged sword|tip of the iceberg|at the forefront of)\b/gi,
    'cliche', 'phrase', 1, 'Cliché. Say the specific point.'],
  [/\bmov(?:e|es|ed|ing) the needle\b|\bsea change\b|\bwatershed moment\b/gi, 'cliche', 'phrase', 2, 'Cliché. Give the number or the change.'],
  [/\b(?:strik(?:e|es|ing)|struck|find(?:s|ing)?) (?:a|the right) balance\b/gi, 'balance', 'phrase', 1, 'Stock phrase. Say what you trade off.'],
  [/\b(?:comprehensive|innovative|sophisticated|unprecedented) (?:approach|solutions?|ecosystem|journey|landscape|experience|integration|impact|suite|strategy)\b/gi,
    'adj-noun', 'vocabulary', 1, 'Buzzword pair. Say what it does.'],
  [/\b(?:valuable|actionable|deep|meaningful|key|unique) insights?\b/gi, 'insights', 'vocabulary', 1, 'Buzzword. State the finding itself.'],
  [/\bdata[- ]driven (?:insights|decisions?|decision[- ]making|approach|strategies|strategy|culture|solutions?)\b/gi, 'insights', 'vocabulary', 1, 'Buzzword. Say what the data showed.'],
  [/\b(?:for|to|across) all (?:our |its |their )?stakeholders\b/gi, 'stakeholders', 'phrase', 1, 'Vague send-off. Name who benefits and how.'],
  [/\b(?:cannot|can['’]t) be (?:overstated|understated|emphasi[sz]ed enough)\b|\bmore (?:important|critical|relevant|crucial|vital|urgent) than ever\b|\b(?:has|have) never been more (?:important|critical|relevant|crucial|vital|urgent)\b/gi,
    'urgency', 'phrase', 2, 'Inflated urgency. Show the stakes with a fact.'],
  [/\bat (?:a|this) (?:critical|pivotal|defining) (?:juncture|moment)\b|\bat a crossroads\b/gi, 'urgency', 'phrase', 2, 'Inflated urgency. Show the stakes with a fact.'],
  [/\bdespite (?:these|the|its|their|such) (?:challenges|hurdles|obstacles|setbacks|limitations)\b|\bwhile challenges remain\b|\bchallenges notwithstanding\b/gi,
    'despite-challenges', 'phrase', 1, 'Stock "despite challenges" turn. Name the challenge or cut it.'],
  [/\b(?:is|are) not without (?:its|their) (?:challenges|drawbacks|risks|limitations)\b|\bcontinues? to thrive\b/gi, 'despite-challenges', 'phrase', 2, 'Stock turn. Name the challenge or cut it.'],
  [/\bthe future (?:looks|is) (?:bright|promising)\b|\bexciting times (?:lie )?ahead\b|\ba step in the right direction\b|\bpoised for (?:growth|success)\b/gi,
    'sendoff', 'closer', 2, 'Upbeat send-off. End on your last concrete fact.'],
  [/\b(?:experts|studies|research|researchers) (?:say|says|believe|argue|agree|suggest|suggests|show|shows|indicate|indicates|warn)\b|\bindustry (?:experts|observers)\b|\b(?:many|some|several) experts\b/gi,
    'vague-authority', 'phrase', 1, 'Unnamed authority. Name the source, or give your own evidence.'],
  [/\b(?:make no mistake|there(?: is|['’]s) no denying|let that sink in|read that again|rest assured)\b/gi, 'emphasis', 'phrase', 2, 'Empty emphasis. Cut it.'],
  [/\b(?:the (?:key|main) takeaways?|to recap|in a nutshell)\b/gi, 'sum-up', 'closer', 2, 'Stock wrap-up. End on your last concrete point.'],
  [/\b(?:at the end of the day|when all is said and done|in the final analysis)\b/gi, 'sum-up', 'closer', 2, 'Stock wrap-up. End on your last concrete point.'],
  [/\b(?:the|this|that)(?: real| key| main)? (?:takeaway|bottom line|upshot|catch|kicker|lesson|truth|reality|answer|result)\s?:(?= \S)/gi,
    'colon-reveal', 'punctuation', 2, 'Colon reveal ("The takeaway: …"). Just state it.'],
  [/\b(?:the (?:truth|reality|fact) is|here['’]s (?:the thing|the deal|the kicker|the catch|why|what|how)|let['’]s be (?:clear|honest|frank|real)|let me be (?:clear|honest|frank|direct))\b/gi,
    'staged-reveal', 'opener', 2, 'Staged run-up. Make the point directly.'],
  [/\blet['’]s (?:dive|delve|explore|unpack|examine|take a (?:closer )?look|look at|walk through|break (?:it|this|that) down|break down)\b|\blet me (?:explain|break (?:it|this) down|walk you through|unpack|elaborate)\b/gi,
    'explainer', 'opener', 2, 'Announces the explanation. Just explain.'],
  [/\bwhether you['’]re (?:a|an|just|new|already|looking|trying)\b/gi, 'era-opener', 'opener', 1, 'Generic reader address. Write to your actual reader.'],
  // sign-offs such as "please let me know if" or "do not hesitate to contact" predate chatbots: not flagged
  [/\bI hope (?:this|that) (?:helps|was helpful|is helpful|answers your question|clarifies)\b/gi, 'chatbot', 'phrase', 2, 'Chatbot sign-off. Delete it.'],
  [/\b(?:great|excellent|fantastic) question\b|\byou['’]re absolutely right\b|\bas an AI\b|\bas a(?:n AI)? language model\b|\bas of my (?:last|latest) (?:update|training)\b|\b(?:certainly|absolutely|of course)!/gi,
    'chatbot', 'phrase', 3, 'Chatbot wording. Delete it.'],
  [/\bhere(?: is|['’]s) (?:a |an |the |your )?(?:revised|rewritten|updated|improved|polished|refined|concise|detailed|brief|quick|clear) (?:version|draft|answer|response|summary|overview|breakdown)\b/gi,
    'chatbot', 'phrase', 3, 'Chatbot wrapper. Delete it.'],
  // riders only after a comma: "…, highlighting the importance of …"; the span starts at the verb
  [/,\s*(?:thereby )?(?:highlighting|underscoring|emphasi[sz]ing|showcasing|symboli[sz]ing) (?:the|its|their|our|a|an|how|that)\b/gi,
    'ing-rider', 'phrase', 2, 'Shallow "-ing" add-on. Keep the fact; cut the gloss.'],
  [/,\s*(?:thereby )?(?:reflecting|demonstrating|reinforcing|solidifying|cementing|signalling|signaling) (?:the|its|their|our|a|an) (?:importance|significance|commitment|dedication|resolve|role|broader|lasting|enduring|position|place|strength)\b/gi,
    'ing-rider', 'phrase', 2, 'Shallow "-ing" add-on. Keep the fact; cut the gloss.'],
  [/,\s*(?:thereby )?(?:ensuring|fostering|cultivating|paving) (?:a|an|the) (?:seamless|smooth|sense|culture|environment|more|robust|holistic|way)\b/gi,
    'ing-rider', 'phrase', 2, 'Shallow "-ing" add-on. Say what actually happens.'],
  [/\b(?:a|an) (?:wide|diverse|broad|rich) (?:array|spectrum|tapestry) of\b/gi, 'array-of', 'phrase', 1, 'Filler. Name the items, or give the number.'],
];

// Sentence-start openers: [regex, rule, category, weight, message, needs-comma]. Checked only where a
// sentence (or line) begins. Weight may be a function of the match.
export const OPENERS = [
  [/\b(moreover|furthermore|additionally)\b/gi, 'transition', 'opener', 2, (w) => `"${w}" opener: a stock AI link. Drop it, or use "Also".`, false],
  [/\b(importantly|crucially|more importantly|equally important(?:ly)?)\b/gi, 'transition', 'opener', 2, (w) => `"${w}" opener: announces importance. Just make the point.`, true],
  [/\b(notably|interestingly|essentially|fundamentally|significantly|in addition|what['’]s more)\b/gi, 'transition', 'opener', 1, (w) => `"${w}" opener: stock link. Cut it.`, true],
  [/\b(in conclusion)\b/gi, 'closer', 'closer', 3, () => '"In conclusion": school-essay closer. End on your last fact.', false],
  [/\b(in summary|to summari[sz]e|to sum up|in closing|all in all|in essence)\b/gi, 'closer', 'closer', 2,
    (w) => `"${w}" closer: stock wrap-up. End on your last fact.`, true],
  [/\b(in short|taken together)\b/gi, 'closer', 'closer', 1, (w) => `"${w}" closer: stock wrap-up. End on your last fact.`, true],
  [/\b(ultimately)\b/gi, 'closer', 'closer', 2, () => '"Ultimately" closer: stock wrap-up. End on your last concrete fact.', false],
  // "Overall," is ordinary in results commentary; only flag it as the last line of a paragraph
  [/\b(overall)\b/gi, 'closer', 'closer', 1, () => '"Overall" wrap-up line. End on your last concrete fact instead.', 'last'],
];

// -ing words that work as prepositions or set phrases at the start of a sentence.
export const ING_SKIP = new Set(('during including excluding regarding concerning considering following according assuming '
  + 'barring pending notwithstanding beginning starting going looking nothing something anything everything morning evening '
  + 'spring string thing things king ring wing sing bring sting swing ceiling building wedding pudding sterling darling '
  + 'earnings savings holdings proceedings findings openings dealings listings rating ratings').split(' '));

// Participles AI reaches for at the start of a sentence ("Leveraging our network, we …").
export const AI_PARTICIPLES = new Set(('leveraging harnessing fostering embracing navigating capitalizing capitalising '
  + 'cultivating empowering streamlining unlocking spearheading championing bolstering elevating integrating '
  + 'recognizing recognising acknowledging understanding drawing building amplifying enhancing driving delving '
  + 'showcasing underscoring highlighting emphasizing emphasising revolutionizing revolutionising transforming').split(' '));

// Words that make a three-item list factual (a list of products, teams or places), so not a rhetorical triad.
export const TRIAD_DOMAIN = new Set(('sourcing underwriting disbursement disbursements collection collections recovery '
  + 'recoveries servicing sanction sanctions origination credit sales operations legal technical valuation audit '
  + 'compliance treasury risk risks loan loans deposit deposits advance advances provision provisions provisioning '
  + 'income expense expenses cost costs branch branches salaried self-employed housing mortgage mortgages home homes '
  + 'gold vehicle vehicles personal business businesses retail wholesale corporate commercial residential rural urban '
  + 'semi-urban metro metros tier lap msme msmes sme smes builder builders developer developers dsa dsas connector '
  + 'connectors agent agents broker brokers bank banks nbfc nbfcs hfc hfcs customer customers borrower borrowers '
  + 'payment payments repayment repayments investment investments insurance equity debt bonds capital liquidity '
  + 'interest fee fees margin margins yield yields tenure tenor rate rates principal emi emis npa npas stage '
  + 'regulator regulators rbi sebi nhb government state states city cities town towns district districts village '
  + 'villages employee employees staff team teams officer officers manager managers board auditor auditors '
  + 'year years month months quarter quarters week weeks day days').split(' '));

// Abstract nouns and adjectives that make a triad rhetorical ("trust, transparency and value").
export const TRIAD_ABSTRACT = new Set(('growth trust value values transparency integrity excellence innovation efficiency '
  + 'resilience agility sustainability inclusion inclusivity empowerment collaboration accountability insight insights '
  + 'inspiration impact experience experiences quality speed scale reliability security stability simplicity clarity '
  + 'confidence commitment passion purpose vision strategy execution discipline governance culture prudence ambition '
  + 'innovative robust seamless scalable sustainable efficient effective reliable transparent resilient inclusive '
  + 'agile secure holistic dynamic strategic proactive meaningful impactful faster simpler better smarter stronger '
  + 'cheaper safer clearer').split(' '));
export const TRIAD_SUFFIX = /(?:ity|ities|ness|ance|ence|ism|ship|ive|ful|ous|able|ible|ient|ent|ant)$/;

// Hedge markers for "hedge stacks" (three or more in one sentence).
export const HEDGES = /\b(?:may|might|could|perhaps|possibly|potentially|arguably|conceivably|somewhat|relatively|generally|typically|likely|seemingly|apparently|to some extent|in some cases|in certain cases|tends? to|appears? to|seems? to)\b/gi;
// Modal plus epistemic adverb ("could potentially").
export const STACKED_HEDGE = /\b(?:could|can|may|might|would) (?:potentially|possibly|perhaps|conceivably|arguably)\b|\bit could be argued that\b/gi;

// Words that are ordinary in Indian finance writing and must never be flagged (checked by tests).
export const DOMAIN_SAFE = ['implement', 'implemented', 'implementation', 'prioritise', 'prioritize', 'prioritised',
  'optimise', 'optimize', 'optimisation', 'facilitate', 'facilitated', 'terminate', 'terminated', 'maximise', 'maximize',
  'minimise', 'minimize', 'disburse', 'disbursed', 'disbursement', 'sanction', 'sanctioned', 'underwriting', 'portfolio',
  'leverage ratio', 'financial leverage', 'operating leverage', 'robust', 'comprehensive', 'significant', 'significantly',
  'utilise', 'utilisation', 'utilization', 'enhanced', 'elevated', 'endeavour', 'aforementioned', 'stakeholders',
  'ecosystem', 'framework', 'strategic', 'provisioning', 'key', 'critical', 'ensure', 'substantial', 'thereby',
  'approximately', 'synergies', 'resilient', 'sustainable', 'commitment', 'journey', 'evolving', 'in order to',
  'with regard to', 'pursuant to', 'kindly', 'therefore', 'hence', 'consequently', 'for example'];

// Words and phrases a rewrite must avoid (for rewrite prompts). Lower case, plain text.
export const BAN_LIST = [
  'delve', 'delve into', 'dive into', 'deep dive', 'underscore', 'underscores', 'showcase', 'showcasing',
  'meticulous', 'meticulously', 'tapestry', 'intricate', 'intricacies', 'testament', 'a testament to', 'pivotal',
  'plays a pivotal role', 'plays a crucial role', 'plays a key role', 'plays a vital role', 'crucial', 'vital',
  'seamless', 'seamlessly', 'holistic', 'multifaceted', 'transformative', 'groundbreaking', 'unparalleled',
  'commendable', 'realm', 'in the realm of', 'embark', 'embark on a journey', 'garner', 'unwavering', 'paramount',
  'myriad', 'plethora', 'burgeoning', 'ever-evolving', 'ever-changing', 'fast-paced', 'game-changer', 'paradigm shift',
  'elevate', 'foster', 'fostering', 'harness', 'harness the power of', 'leverage (as a verb)', 'leveraging',
  'interplay', 'vibrant', 'bustling', 'nestled', 'spearhead', 'revolutionize', 'resonate', 'impactful', 'navigate',
  'navigate the complexities', 'landscape', "in today's world", "in today's landscape", "in today's fast-paced world",
  'in an era of', 'in an increasingly', 'first and foremost', 'last but not least', 'it is important to note',
  "it's worth noting", 'it goes without saying', 'needless to say', 'that being said', 'moreover', 'furthermore',
  'additionally', 'notably', 'importantly', 'ultimately', 'in conclusion', 'in summary', 'to sum up', 'overall,',
  'at the end of the day', 'not just … but', 'not only … but also', "it's not … it's", 'serves as a',
  'stands as a', 'a cornerstone of', 'paves the way', 'sets the stage', 'marks a pivotal moment',
  'unlock the potential', 'cannot be overstated', 'more important than ever', 'at a critical juncture',
  'despite these challenges', 'continues to thrive', 'the future looks bright', 'a step in the right direction',
  'for all stakeholders', 'valuable insights', 'actionable insights', 'data-driven insights', 'could potentially',
  'may possibly', 'experts say', 'studies show', 'key takeaway', 'here is a revised version', 'i hope this helps',
  'let me know if', 'great question', 'cutting-edge', 'state-of-the-art', 'best-in-class', 'proactive', 'empower',
  'streamline', 'bolster', 'nuanced', 'enhancing', 'by seamlessly', 'strike a balance', 'em dashes (—)'];
