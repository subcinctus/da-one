// Lookalike letters for normalize.mjs. Generated from Unicode TR39 confusables.txt 17.0.0 (2025-07-22),
// https://www.unicode.org/Public/security/17.0.0/confusables.txt (mirror:
// github.com/unicode-org/unicodetools, unicodetools/data/security/17.0.0/confusables.txt).
// © Unicode, Inc. Unicode License v3 (SPDX: Unicode-3.0), https://www.unicode.org/license.txt
//
// Kept rows: one non-ASCII letter (not a modifier letter, not a fullwidth form) whose skeleton is one
// ASCII letter, in the scripts below. Common-script styled letters (math bold/italic, ℂ ℓ …) use their
// NFKC letter. TR39 folds capital I into l; capital and caseless sources are stored as I here, and
// normalize.mjs picks I or l from the neighbouring letters.
// Left out on purpose: ı ſ þ ƿ ƒ ǀ ʋ ɣ ɩ Ɩ ℹ (real letters of other orthographies, a wrong target,
// the florin sign, the ℹ emoji). "strict" (chosen by hand) means the letter renders like its Latin
// twin in common fonts, so a word made only of such letters may be mapped; "loose" letters are only
// mapped inside a mixed-script word of four or more letters. Each entry is "<lookalike><ASCII letter>".
export const TR39_VERSION = '17.0.0';

export const LOOKALIKES = {
  Cyrl: {
    strict:
      'аa АA ВB сc СC ԁd еe ЕE һh НH іi ІI ӀI јj ЈJ КK ӏl МM оo ОO рp РP ԛq ѕs ЅS ТT ԝw ԜW хx ХX уy УY ' +
      'ҮY',
    loose: 'Ьb ҽe ԌG ꙇi гr ѵv ѴV шw ѡw үy',
  },
  Grek: {
    strict: 'ΑA ΒB ϲc ϹC ΕE ΗH ΙI ϳj ͿJ ΚK ΜM ΝN οo ΟO ΡP ΤT ΧX ΥY ΖZ',
    loose: 'αa ϜF ιi ιi ϺM σo ρp ϱp ϸp ᴦr υu νv γy ϒY',
  },
  Armn: {
    strict: 'հh ոn օo ՕO սu ՍU',
    loose: 'քf ցg ւi ռn գq զq ՏS աw',
  },
  Cher: {
    strict: 'ᎪA ᏴB ᏟC ᎠD ᎬE ᏀG ᎻH ᎫJ ᏦK ᏞL ᎷM ᏢP ᎡR ᏚS ᎢT ᏙV ᎳW ᎩY ᏃZ',
    loose: 'Ꮟb ꮯc Ꮷd ᏳG Ꮒh Ꭵi ꭵi ꮁr ᏒR ꮪs ᏕS ꮩv ꮃw ᏔW ᎽY ꮓz',
  },
  Lisu: {
    strict: 'ꓮA ꓐB ꓚC ꓓD ꓰE ꓝF ꓖG ꓧH ꓲI ꓙJ ꓗK ꓡL ꓟM ꓠN ꓳO ꓑP ꓣR ꓢS ꓔT ꓴU ꓦV ꓪW ꓫX ꓬY ꓜZ',
    loose: 'ꓒd',
  },
  Copt: {
    strict: '',
    loose: 'ⲂB ⲥc ⲤC ⲎH ⲓi ⲒI ⲔK ⳐL ⲘM ⲚN ϭo ⲟo ⲞO ⲣp ⳏp ⲢP ⳎP ⲅr ⲦT ⲽw ⲬX ⲩy ⲨY',
  },
  Latn: {
    strict: 'ɑa ꞴB ɡg KK ꞳX',
    loose: 'Ƅb ᴄc ꬲe ẝf ꞙf ꬵf ꞘF ƍg ᶃg ɪi ꞲJ ᴏo ᴑo ꬽo ꭇr ꭈr ƦR ƽs ꜱs ᴜu ꞟu ꭎu ꭒu ᴠv ɯw ᴡw ʏy ᶌy ỿy ꭚy ᴢz',
  },
  Zyyy: {
    strict:
      '𝐚a 𝑎a 𝒂a 𝒶a 𝓪a 𝔞a 𝕒a 𝖆a 𝖺a 𝗮a 𝘢a 𝙖a 𝚊a 𝐀A 𝐴A 𝑨A 𝒜A 𝓐A 𝔄A 𝔸A 𝕬A 𝖠A 𝗔A 𝘈A ' +
      '𝘼A 𝙰A 𝐛b 𝑏b 𝒃b 𝒷b 𝓫b 𝔟b 𝕓b 𝖇b 𝖻b 𝗯b 𝘣b 𝙗b 𝚋b ℬB 𝐁B 𝐵B 𝑩B 𝓑B 𝔅B 𝔹B 𝕭B 𝖡B ' +
      '𝗕B 𝘉B 𝘽B 𝙱B 𝐜c 𝑐c 𝒄c 𝒸c 𝓬c 𝔠c 𝕔c 𝖈c 𝖼c 𝗰c 𝘤c 𝙘c 𝚌c ℂC ℭC 𝐂C 𝐶C 𝑪C 𝒞C 𝓒C ' +
      '𝕮C 𝖢C 𝗖C 𝘊C 𝘾C 𝙲C ⅆd 𝐝d 𝑑d 𝒅d 𝒹d 𝓭d 𝔡d 𝕕d 𝖉d 𝖽d 𝗱d 𝘥d 𝙙d 𝚍d ⅅD 𝐃D 𝐷D 𝑫D ' +
      '𝒟D 𝓓D 𝔇D 𝔻D 𝕯D 𝖣D 𝗗D 𝘋D 𝘿D 𝙳D ℯe ⅇe 𝐞e 𝑒e 𝒆e 𝓮e 𝔢e 𝕖e 𝖊e 𝖾e 𝗲e 𝘦e 𝙚e 𝚎e ℰE ' +
      '𝐄E 𝐸E 𝑬E 𝓔E 𝔈E 𝔼E 𝕰E 𝖤E 𝗘E 𝘌E 𝙀E 𝙴E 𝐟f 𝑓f 𝒇f 𝒻f 𝓯f 𝔣f 𝕗f 𝖋f 𝖿f 𝗳f 𝘧f 𝙛f ' +
      '𝚏f ℱF 𝐅F 𝐹F 𝑭F 𝓕F 𝔉F 𝔽F 𝕱F 𝖥F 𝗙F 𝘍F 𝙁F 𝙵F ℊg 𝐠g 𝑔g 𝒈g 𝓰g 𝔤g 𝕘g 𝖌g 𝗀g 𝗴g ' +
      '𝘨g 𝙜g 𝚐g 𝐆G 𝐺G 𝑮G 𝒢G 𝓖G 𝔊G 𝔾G 𝕲G 𝖦G 𝗚G 𝘎G 𝙂G 𝙶G ℎh 𝐡h 𝒉h 𝒽h 𝓱h 𝔥h 𝕙h 𝖍h ' +
      '𝗁h 𝗵h 𝘩h 𝙝h 𝚑h ℋH ℌH ℍH 𝐇H 𝐻H 𝑯H 𝓗H 𝕳H 𝖧H 𝗛H 𝘏H 𝙃H 𝙷H ⅈi 𝐢i 𝑖i 𝒊i 𝒾i 𝓲i 𝔦i ' +
      '𝕚i 𝖎i 𝗂i 𝗶i 𝘪i 𝙞i 𝚒i ℐI ℑI 𝐈I 𝐼I 𝑰I 𝓘I 𝕀I 𝕴I 𝖨I 𝗜I 𝘐I 𝙄I 𝙸I ⅉj 𝐣j 𝑗j 𝒋j 𝒿j ' +
      '𝓳j 𝔧j 𝕛j 𝖏j 𝗃j 𝗷j 𝘫j 𝙟j 𝚓j 𝐉J 𝐽J 𝑱J 𝒥J 𝓙J 𝔍J 𝕁J 𝕵J 𝖩J 𝗝J 𝘑J 𝙅J 𝙹J 𝐤k 𝑘k ' +
      '𝒌k 𝓀k 𝓴k 𝔨k 𝕜k 𝖐k 𝗄k 𝗸k 𝘬k 𝙠k 𝚔k 𝐊K 𝐾K 𝑲K 𝒦K 𝓚K 𝔎K 𝕂K 𝕶K 𝖪K 𝗞K 𝘒K 𝙆K 𝙺K ' +
      'ℓl 𝐥l 𝑙l 𝒍l 𝓁l 𝓵l 𝔩l 𝕝l 𝖑l 𝗅l 𝗹l 𝘭l 𝙡l 𝚕l ℒL 𝐋L 𝐿L 𝑳L 𝓛L 𝔏L 𝕃L 𝕷L 𝖫L 𝗟L ' +
      '𝘓L 𝙇L 𝙻L ℳM 𝐌M 𝑀M 𝑴M 𝓜M 𝔐M 𝕄M 𝕸M 𝖬M 𝗠M 𝘔M 𝙈M 𝙼M 𝐧n 𝑛n 𝒏n 𝓃n 𝓷n 𝔫n 𝕟n 𝖓n ' +
      '𝗇n 𝗻n 𝘯n 𝙣n 𝚗n ℕN 𝐍N 𝑁N 𝑵N 𝒩N 𝓝N 𝔑N 𝕹N 𝖭N 𝗡N 𝘕N 𝙉N 𝙽N ℴo 𝐨o 𝑜o 𝒐o 𝓸o 𝔬o ' +
      '𝕠o 𝖔o 𝗈o 𝗼o 𝘰o 𝙤o 𝚘o 𝐎O 𝑂O 𝑶O 𝒪O 𝓞O 𝔒O 𝕆O 𝕺O 𝖮O 𝗢O 𝘖O 𝙊O 𝙾O 𝐩p 𝑝p 𝒑p 𝓅p ' +
      '𝓹p 𝔭p 𝕡p 𝖕p 𝗉p 𝗽p 𝘱p 𝙥p 𝚙p ℙP 𝐏P 𝑃P 𝑷P 𝒫P 𝓟P 𝔓P 𝕻P 𝖯P 𝗣P 𝘗P 𝙋P 𝙿P 𝐪q 𝑞q ' +
      '𝒒q 𝓆q 𝓺q 𝔮q 𝕢q 𝖖q 𝗊q 𝗾q 𝘲q 𝙦q 𝚚q ℚQ 𝐐Q 𝑄Q 𝑸Q 𝒬Q 𝓠Q 𝔔Q 𝕼Q 𝖰Q 𝗤Q 𝘘Q 𝙌Q 𝚀Q ' +
      '𝐫r 𝑟r 𝒓r 𝓇r 𝓻r 𝔯r 𝕣r 𝖗r 𝗋r 𝗿r 𝘳r 𝙧r 𝚛r ℛR ℜR ℝR 𝐑R 𝑅R 𝑹R 𝓡R 𝕽R 𝖱R 𝗥R 𝘙R 𝙍R ' +
      '𝚁R 𝐬s 𝑠s 𝒔s 𝓈s 𝓼s 𝔰s 𝕤s 𝖘s 𝗌s 𝘀s 𝘴s 𝙨s 𝚜s 𝐒S 𝑆S 𝑺S 𝒮S 𝓢S 𝔖S 𝕊S 𝕾S 𝖲S 𝗦S ' +
      '𝘚S 𝙎S 𝚂S 𝐭t 𝑡t 𝒕t 𝓉t 𝓽t 𝔱t 𝕥t 𝖙t 𝗍t 𝘁t 𝘵t 𝙩t 𝚝t 𝐓T 𝑇T 𝑻T 𝒯T 𝓣T 𝔗T 𝕋T 𝕿T ' +
      '𝖳T 𝗧T 𝘛T 𝙏T 𝚃T 𝐮u 𝑢u 𝒖u 𝓊u 𝓾u 𝔲u 𝕦u 𝖚u 𝗎u 𝘂u 𝘶u 𝙪u 𝚞u 𝐔U 𝑈U 𝑼U 𝒰U 𝓤U 𝔘U ' +
      '𝕌U 𝖀U 𝖴U 𝗨U 𝘜U 𝙐U 𝚄U 𝐯v 𝑣v 𝒗v 𝓋v 𝓿v 𝔳v 𝕧v 𝖛v 𝗏v 𝘃v 𝘷v 𝙫v 𝚟v 𝐕V 𝑉V 𝑽V 𝒱V ' +
      '𝓥V 𝔙V 𝕍V 𝖁V 𝖵V 𝗩V 𝘝V 𝙑V 𝚅V 𝐰w 𝑤w 𝒘w 𝓌w 𝔀w 𝔴w 𝕨w 𝖜w 𝗐w 𝘄w 𝘸w 𝙬w 𝚠w 𝐖W 𝑊W ' +
      '𝑾W 𝒲W 𝓦W 𝔚W 𝕎W 𝖂W 𝖶W 𝗪W 𝘞W 𝙒W 𝚆W 𝐱x 𝑥x 𝒙x 𝓍x 𝔁x 𝔵x 𝕩x 𝖝x 𝗑x 𝘅x 𝘹x 𝙭x 𝚡x ' +
      '𝐗X 𝑋X 𝑿X 𝒳X 𝓧X 𝔛X 𝕏X 𝖃X 𝖷X 𝗫X 𝘟X 𝙓X 𝚇X 𝐲y 𝑦y 𝒚y 𝓎y 𝔂y 𝔶y 𝕪y 𝖞y 𝗒y 𝘆y 𝘺y ' +
      '𝙮y 𝚢y 𝐘Y 𝑌Y 𝒀Y 𝒴Y 𝓨Y 𝔜Y 𝕐Y 𝖄Y 𝖸Y 𝗬Y 𝘠Y 𝙔Y 𝚈Y 𝐳z 𝑧z 𝒛z 𝓏z 𝔃z 𝔷z 𝕫z 𝖟z 𝗓z ' +
      '𝘇z 𝘻z 𝙯z 𝚣z ℤZ ℨZ 𝐙Z 𝑍Z 𝒁Z 𝒵Z 𝓩Z 𝖅Z 𝖹Z 𝗭Z 𝘡Z 𝙕Z 𝚉Z',
    loose: '',
  },
};
