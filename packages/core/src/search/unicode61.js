// SQLite FTS5 tokenizer 'unicode61 remove_diacritics 2' (the artifact_search index), reproduced for search excerpts.
// The tables were read from SQLite 3.53.4 (node:sqlite) by indexing "a" + each code point + "b" and reading fts5vocab;
// unicode61 uses fixed Unicode 6.1 data, so they do not change with SQLite or JavaScript versions.
// test/search-excerpt-differential.test.mjs checks them against node:sqlite.

// Code points that separate tokens (ranges of base-36 code points).
const U61_SEPARATORS = "0-1b,1m-1s,2j-2o,3f-4p,4r-4x,50,52-54,57,5b,5z,6v,jm-jp,k2-kf,kl-kr,kt,kv-lb,lh,lp-lq,ls,lu-m2,m4-ma,mh-mk,mn," +
  "mq-of,ol,ou,p0-p1,p3,s6,w2-w9,122-127,13d-13e,13j,13l-153,16b-16c,16o-16s,16u-17f,17i-17j,18r-19b,19m-19p,19s," +
  "1ck,1cm-1d0,1d3-1d9,1dp-1dq,1ds-1e5,1e7,1e9,1f4-1fu,1ie-1io,1kb-1kj,1km-1kp,1li-1ll,1ln-1lv,1lx-1lz,1m1-1m5,1m" +
  "8-1mm,1nd-1nf,1ni,1r8-1ry,1s0-1s3,1tm-1to,1tq-1u7,1u9-1uf,1uq-1ut,1v4,1vl-1vn,1x8,1xa-1xg,1xj-1xk,1xn-1xp,1xz," +
  "1ya-1yb,1yq-1yr,1yy-1yz,1z5-1z7,20s,20u-20y,213-214,217-219,21d,228-229,22d,22p-22r,24c,24e-24l,24n-24p,24r-24" +
  "t,25e-25f,25s-25t,269-26b,27w,27y-284,287-288,28b-28d,28m-28n,28y-28z,29c,29u,2bi-2bm,2bq-2bs,2bu-2bx,2c7,2cz-" +
  "2d6,2dd-2df,2f2-2f8,2fa-2fc,2fe-2fh,2fp-2fq,2g2-2g3,2gv,2gy-2gz,2ik,2im-2is,2iu-2iw,2iy-2j1,2j9-2ja,2jm-2jn,2k" +
  "i-2kj,2m6-2mc,2me-2mg,2mi-2ml,2mv,2n6-2n7,2nt,2o2-2o3,2q2,2q7-2qc,2qe,2qg-2qn,2r6-2r8,2sx,2t0-2t6,2tb,2tj-2tr," +
  "2u2-2u3,2wh,2wk-2wp,2wr-2ws,2x4-2x9,2yp-2zj,304-30f,31t-32f,32l-32v,32x-33w,33y-34c,34e-34q,36z-37i,37u-37z,38" +
  "6-389,38e-38g,38i-38k,38n-38t,38x-390,39e-39p,39r,3a2-3a7,3cr,3tp-3u0,3v4-3vd,3y8,4fh-4fi,4g0,4gr-4gs,4iz-4j1," +
  "4k2-4k4,4ky-4l2,4lu-4lv,4mq-4mr,4ok-4pi,4pk-4pn,4pp,4qo-4r2,4vd,4yo-4yz,4z4-4zf,4zk,4zo-4zp,52o-534,53c-53d,53" +
  "y-54v,55j-55n,55q-55r,579-57i,57k-58c,58f,59c-59i,59k-59p,5c0-5c4,5dg-5dw,5ei-5fg,5fk-5fm,5gh-5gt,5ie-5ir,5j0-" +
  "5j3,5k4-5kn,5kr-5kv,5mm-5mn,5og-5on,5ow-5pk,5pp,5pu-5pw,5vk-5wm,5x8-5xb,69p,69r-69t,6a5-6a7,6al-6an,6b1-6b3,6b" +
  "h-6bi,6bk-6ec,6ei-6en,6ey-6f2,6fe-6fi,6g0-6gp,6hc-6i8,6io-6ip,6ir-6iu,6iw-6ix,6j8,6ja-6jc,6ji-6jn,6jp,6jr,6jt," +
  "6jy,6ka-6kb,6kg-6kk,6kq-6kt,6kv,6mo-73n,740-752,75s-762,78c-7ah,7b4-7pb,7pd-7sl,7tg-8jw,8k0-8k9,8v9-8ve,8vj-8v" +
  "l,8vt-8vw,8vy-8vz,8z4,8zj,928-94e,94g-94r,96o-97d,97f-99v,9a8-9g5,9gw-9h7,9hc-9hg,9hk-9i8,9ii-9io,9iu-9iv,9j1-" +
  "9j3,9ll-9lo,9ls,9ob,9sg-9sh,9sm-9sv,9ts-9ur,9vk-9we,9wq-9xj,9xs,9y8-9z3,9ze-a0g,a0w-a2m,a2o-a9r,fcw-fen,wi8-wj" +
  "q,wla-wlb,wst-wsv,wvj-wvy,wwv,wz4-wzb,wzk-x06,x0g-x0h,x3d-x3e,x6q,x6u,x6z,x7n-x7v,x86-x89,x9w-x9z,xa8-xa9,xbo-" +
  "xc4,xce-xcf,xcw-xdd,xdk-xdm,xeu-xf3,xfr-xg3,xgf,xhc-xhf,xir-xjh,xjy-xjz,xm1-xme,xmr,xn0-xn1,xng-xnj,xo7-xo9,xo" +
  "b,xps,xpu-xpw,xpz-xq0,xq6-xq7,xq9,xr2-xr3,xrf-xrl,xrp-xrq,xyb-xyl,1dlq,1dm1,1dpu-1dq9,1e0u-1e0v,1e64-1e65,1e68" +
  "-1e6x,1e74-1e7a,1e7k-1e8i,1e8k-1e92,1e94-1e97,1edb,1edd-1edr,1ee2-1ee8,1eez-1ef4,1efv-1eg5,1ejk-1ejq,1ejs-1ejy" +
  ",1ek9-1ekf,1erk-1erm,1et3-1etb,1eux-1evd,1evk-1evv,1exc-1eyl,1fa7,1fbk,1g7r,1gdb,1ge7,1gjl-1gjn,1gjp-1gjq,1gjw" +
  "-1gjz,1gl4-1gl6,1glb,1gls-1gm0,1gn3,1gs9-1gsf,1hq8-1hqa,1hrs-1hsd,1hts-1htu,1hv4-1hvl,1hxc-1hxe,1hyf-1hys,1hz4" +
  "-1hz7,1i0w-1i0y,1i2b-1i2o,1i2t-1i2w,1j1n-1j1z,1lrk-1lrn,20k1-20la,20lr-20lu,2jnk-2jud,2juo-2jvq,2jvt-2k0t,2k1s" +
  "-2k3p,2k8w-2kba,2kzl,2l0b,2l17,2l1x,2l2t,2l3j,2l4f,2l55,2l61,2l6r,2prk-2prl,2pz4-2q0b,2q0g-2q37,2q3k-2q3y,2q41" +
  "-2q4e,2q4h-2q4v,2q4x-2q5b,2q6o-2q7i,2q7k-2q97,2q9c-2qai,2qcm-2qde,2qds-2qey,2qf4-2qfc,2qfk-2qfl,2qkg-2qlc,2qls" +
  "-2qlx,2qlz-2qnw,2qo0-2qoj,2qow-2qpw,2qpy-2qq2,2qqo-2qr4,2qrk-2qta,2qtc,2qte-2qyf,2qyh-2qyk,2qyo-2r0d,2r0g-2r0j" +
  ",2r0w-2r1j,2r5n-2r7k,2r7p-2r7z,2r9c-2rb9,2rcw-2rg3,jny9,jnz4-jo1r,jo5c-jobz";
// Combining marks U+0300–U+0331 that remove_diacritics 2 drops inside a token; other marks separate tokens.
const U61_DROPPED = "\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d-\u032e\u0330-\u0331";
// Letters that fold to an ASCII base letter: each group is the base followed by the letters folding to it.
const U61_TO_ASCII = "aÀÁÂÃÄÅàáâãäåĀāĂăĄąǍǎǞǟǺǻȀȁȂȃȦȧḀḁẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặÅ cÇçĆćĈĉĊċČčḈḉ eÈÉÊËèé" +
  "êëĒēĔĕĖėĘęĚěȄȅȆȇȨȩḔḕḖḗḘḙḚḛḜḝẸẹẺẻẼẽẾếỀềỂểỄễỆệ iÌÍÎÏìíîïĨĩĪīĬĭĮįİǏǐȈȉȊȋḬḭḮḯỈỉỊị nÑ" +
  "ñŃńŅņŇňǸǹṄṅṆṇṈṉṊṋ oÒÓÔÕÖòóôõöŌōŎŏŐőƠơǑǒǪǫǬǭȌȍȎȏȪȫȬȭȮȯȰȱṌṍṎṏṐṑṒṓỌọỎỏỐốỒồỔổỖỗỘộỚớỜ" +
  "ờỞởỠỡỢợ uÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲųƯưǓǔǕǖǗǘǙǚǛǜȔȕȖȗṲṳṴṵṶṷṸṹṺṻỤụỦủỨứỪừỬửỮữỰự yÝýÿŶŷŸȲȳẎ" +
  "ẏẙỲỳỴỵỶỷỸỹ dĎďḊḋḌḍḎḏḐḑḒḓ gĜĝĞğĠġĢģǦǧǴǵḠḡ hĤĥȞȟḢḣḤḥḦḧḨḩḪḫẖ jĴĵǰ kĶķǨǩḰḱḲḳḴḵK lĹĺĻ" +
  "ļĽľḶḷḸḹḺḻḼḽ rŔŕŖŗŘřȐȑȒȓṘṙṚṛṜṝṞṟ sŚśŜŝŞşŠšſȘșṠṡṢṣṤṥṦṧṨṩẛ tŢţŤťȚțṪṫṬṭṮṯṰṱẗ wŴŵẀẁẂẃ" +
  "ẄẅẆẇẈẉẘ zŹźŻżŽžẐẑẒẓẔẕ bḂḃḄḅḆḇ fḞḟ mḾḿṀṁṂṃ pṔṕṖṗ vṼṽṾṿ xẊẋẌẍ";
// Other case folding: runs of start.count.step.delta (base 36) mapping code point c to c + delta.
const U61_LOWER = "51.1.1.lj,5i.1.1.w,5s.1.1.w,60.1.1.w,66.1.1.w,7k.1.1.1,86.1.1.1,8i.1.1.1,8v.2.2.1,96.1.1.1,9e.1.1.1,9y.1.1.1,a" +
  "p.1.1.5u,aq.2.2.1,au.1.1.5q,av.1.1.1,ax.2.1.5p,az.1.1.1,b2.1.1.27,b3.1.1.5m,b4.1.1.5n,b5.1.1.1,b7.1.1.5p,b8.1." +
  "1.5r,ba.1.1.5v,bb.1.1.5t,bc.1.1.1,bg.1.1.5v,bh.1.1.5x,bj.1.1.5y,bm.2.2.1,bq.1.1.62,br.1.1.1,bt.1.1.62,bw.1.1.1" +
  ",by.1.1.62,c1.2.1.61,c3.2.2.1,c7.1.1.63,c8.1.1.1,cc.1.1.1,ck.1.1.2,cl.1.1.1,cn.1.1.2,co.1.1.1,cq.1.1.2,cr.1.1." +
  "1,dc.3.2.1,dq.1.1.1,dt.1.1.2,du.1.1.1,dy.1.1.-2p,dz.1.1.-1k,e4.2.2.1,f0.1.1.1,f4.1.1.-3m,f6.2.2.1,fu.1.1.8bv,f" +
  "v.1.1.1,fx.1.1.-4j,fy.1.1.8bs,g1.1.1.1,g3.1.1.-5f,g4.1.1.1x,g5.1.1.1z,g6.5.2.1,og.2.2.1,om.1.1.1,p2.1.1.12,p4." +
  "3.1.11,p8.1.1.1s,pa.2.1.1r,pd.h.1.w,pv.9.1.w,qq.1.1.1,r3.1.1.8,r4.1.1.-u,r5.1.1.-p,r9.1.1.-f,ra.1.1.-m,rc.c.2." +
  "1,s0.1.1.-1i,s1.1.1.-1c,s4.1.1.-1o,s5.1.1.-1s,s7.1.1.1,s9.1.1.-7,sa.1.1.1,sd.3.1.-3m,sg.g.1.28,sw.w.1.w,v4.h.2" +
  ".1,wa.r.2.1,xs.1.1.f,xt.7.2.1,y8.18.2.1,10x.12.1.1c,3a8.12.1.5ls,3bb.1.1.5ls,3bh.1.1.5ls,61q.1.1.-5vj,64a.3.2." +
  "1,64o.8.1.-8,654.6.1.-8,65k.8.1.-8,660.8.1.-8,66g.6.1.-8,66x.4.2.-8,67c.8.1.-8,688.8.1.-8,68o.8.1.-8,694.8.1.-" +
  "8,69k.2.1.-8,69m.2.1.-22,69o.1.1.-9,69q.1.1.-5j9,6a0.4.1.-2e,6a4.1.1.-9,6ag.2.1.-8,6ai.2.1.-2s,6aw.2.1.-8,6ay." +
  "2.1.-34,6b0.1.1.-7,6bc.2.1.-3k,6be.2.1.-3i,6bg.1.1.-9,6jq.1.1.-5st,6k2.1.1.s,6lc.g.1.g,6mb.1.1.1,8ow.1b.1.1c,8" +
  "rk.1.1.1,8rm.1.1.-8af,8rn.1.1.-2xy,8ro.1.1.-89z,8rr.3.2.1,8rx.1.1.-8bg,8ry.1.1.-8al,8rz.1.1.-8bj,8s0.1.1.-8bi," +
  "8s2.1.1.1,8s5.1.1.1,8se.2.1.-8cf,8sg.1e.2.1,8vf.2.2.1,8vm.1.1.1,wu8.n.2.1,ww0.c.2.1,x0i.7.2.1,x0y.v.2.1,x2x.2." +
  "2.1,x31.1.1.-r9g,x32.5.2.1,x3f.1.1.1,x3h.1.1.-wmg,x3k.2.2.1,x40.5.2.1,x4a.1.1.-wn8,1ee9.q.1.w,1fcw.14.1.14";

const u61Fold = new Map();
for (const group of U61_TO_ASCII.split(" ")) { const [base, ...letters] = Array.from(group); for (const l of letters) u61Fold.set(l, base); }
for (const run of U61_LOWER.split(",")) {
  const [s, n, step, d] = run.split(".").map((x) => parseInt(x, 36));
  for (let i = 0; i < n; i++) u61Fold.set(String.fromCodePoint(s + i * step), String.fromCodePoint(s + i * step + d));
}
const u61Separators = U61_SEPARATORS.split(",").map((r) => r.split("-").map((x) => "\\u{" + parseInt(x, 36).toString(16) + "}").join("-")).join("");
/** One token: a token character, then token characters or dropped marks (dropped marks before it belong to no token). */
const U61_TOKEN = new RegExp("[^" + u61Separators + U61_DROPPED + "][^" + u61Separators + "]*", "gu");
const U61_DROPPED_RE = new RegExp("[" + U61_DROPPED + "]", "gu");

/** The index term for one token (a U61_TOKEN match): dropped marks removed, case and listed accents folded. */
function u61FoldToken(word) {
  if (/^[\x00-\x7f]*$/.test(word)) return word.toLowerCase();
  let out = "";
  for (const ch of word.replace(U61_DROPPED_RE, "")) { const f = u61Fold.get(ch); out += f ?? (ch < "\x80" ? ch.toLowerCase() : ch); }
  return out;
}

export { U61_TOKEN, u61FoldToken };
