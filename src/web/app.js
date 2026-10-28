(function () {
"use strict";
var S = { me: null, csrf: null, cleanups: [], offline: false };
var EDITOR_URL = "/editor.${EDITOR_JS_SHA256.slice(0, 16)}.js";
var FRAME_SANDBOX = ${JSON.stringify(FRAME_SANDBOX)};
// Lazy-load the syntax-highlighting editor once per page; resolves null offline or on any failure
// (callers keep the plain textarea). Same-origin script, allowed by script-src 'self'.
var editorP = null;
function loadEditor() {
  if (S.offline || !navigator.onLine) return Promise.resolve(null);
  if (window.AL_EDITOR && window.AL_EDITOR.mountEditor) return Promise.resolve(window.AL_EDITOR);
  if (!editorP) editorP = new Promise(function (res) {
    var sc = document.createElement("script");
    sc.src = EDITOR_URL; sc.async = true;
    sc.onload = function () { res(window.AL_EDITOR && window.AL_EDITOR.mountEditor ? window.AL_EDITOR : null); };
    sc.onerror = function () { editorP = null; res(null); };
    document.head.appendChild(sc);
  });
  return editorP;
}
// The document editor currently on screen (CodeMirror adapter or plain textarea), for resume/caret logic.
var activeEd = null;
// Read-only accessor for browser tests and debugging (returns the same object the app uses; no new capability).
window.__alActiveEditor = function () { return activeEditor(); };
function activeEditor() {
  if (activeEd && activeEd.dom && document.contains(activeEd.dom)) return activeEd;
  var ta = document.querySelector("textarea.editor");
  return ta && !ta.hidden ? ta : null;
}
${HOME_JS}
var app = document.getElementById("app");
var crumbsEl = document.getElementById("crumbs");
var whoEl = document.getElementById("who");
var navEl = document.getElementById("nav");
// ---------- brand mark: the approved "Fold" A. Original 128 px crop from the brand concept sheet
// (sheet sha256 836d0ede…, crop sha256 ed862b3e…; scripts/design/extract-logo.mjs), restored byte-for-byte from
// commit b4e9caf. Shown via a blob: URL because the app CSP allows img-src 'self' blob:. The "A" tile in the HTML
// stays as the fallback if decoding fails.
var FOLD_MARK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAQAElEQVR4Aey9CbylVXXm/ax9zr23qm7NE1CCgKISEXGIRuNs4hC/T7vtRNM/E4ytIIraGKM4YVLaaEKbSIsjINFoBiNJtI0xbZzQVj9NRBAHEEEQkKEKqLnqDue8+/s/6z3nVjEUVBU1CbXvXnuvea+91n6Hc+4tKDrQ7tMZOHAA7tPllw4cgAMH4D6egfv49g/cAQ4cgPt4Bu7j2z9wBzhwAO7jGbiPbn+47QN3gGEm7qPzgQNwHy38cNsHDsAwE/fR+cABuI8Wfrjte88BePn1c15x7oanv+7czf/9FR9Yf+prP7L+1Fecs+5Zh/7htbOHmz0w3zEDv9QH4LfO+unYM/90w1sf/YZ19dD++KavfU9f/tIl/fd+48dxxhe/pzO+/B/l/5T18zY/4U1r6vPPWHv+az98y+MfffZ3R+6Yhvsu55f2APy3M9e+6/Ifrpi4dVU9fXJLaNHsUKfTV782gOcK3Wh8JHTr2o6uvK78zjd+Mutba777kKknvnlNPfHD6/7+NWfdMv8Fn6od3YfbL+UBOObV67Z896edN88Z7WlquvIbrSpReDVSgHpTRVUFIgDP/X5Ft6e5s/vauEn67o/1wq9f3l138ZfW9R79hlU3vepj68/VfaDdfovO1e15+y39//zpxt+833/bUCcm66ypfk+9XqNev4U+ha8K1VrFpFKCAxBGxenI2Tr9vjTdC031JMzVJQNb1s9a/tXvlBMe/MoN9RGnrG+etXLDF19w5vrHY3iv72z/l2OPzz59wwsuvbL54pzRStGqggK7qi54QlNzIx59BhoG4wHXULkjVHSaxsehcrMA0IkIhbNQqka4W/SmFTfeot/80RX61tGvXFuf9tZbL339X6579REvuWohru513Vvf7zf1jJVrn/nTq6Y/NVoaitTnAEiFgkZG7tEgNX4MUFRuA0pApyIygNIrbEPwqIi0RhE+KIfDB6mB6oN3OAy+O6xeE0d/+WK9LzoL1zzujbfW//eMdR8/5a9ufTgW94q+3x+AlSt/OHrFtfEFP8tdYBdJXPolQkNwKQu8cKWraKGIcG0pOBNXvQtLbVWQujfcA5CYBVnRr7K/iIDnQ1IRGw9N8qwYnxXasL6ja66J479+0cj3l79kbT3+Pevr4994068/dWXt4uSXsg/zsd8G/5nVh26cx21/rBuit3FylfsgGKiX8hZOvX1IIkAoYcNVjBr6FNIsBT/UFE7A4o4PDQ99OtxBx8h+mfKImIsWU6iQrQq31+vroHnS969uNDE565trb1k3/dBT1qx+zXnrP3rEyqtm6ZeosaX9N9onv+Gm9VRppC2sVDqhDhEnrba5WNQbouaUNFSEr14KTrFbHgg8urj/AyGkoA13CWRYV4prXR8QcTcJTkErQROkSRq/yCrg94npXhVd0StLv3xhfUn3hiVbHnbKuvrY09Zc8PsfXvsMFtmvO+ncP+P7gz9d//JVG0fnTU03ash0e8WK80AxVLNofqlLqKZlAXIXliJBQsgFD7U/aMGNhHCVEVJXpLDouPEI4CrlUoT1RWs1PSYwWL+Fdj3jXWKbnuBxcfPIU757ceffHnLShvqbf7z2specdcuJB73+xnEc7Vd9vzwALz1j9byvXtqc3W2mNerK83I3NbVF01MTHIYKFD7+SX5Z407PYaBgzj6prRTAjCwbPHpyW15yrQwJThFT3RrGmaWtKUkWC0TyPeCdwyh4vlPYt8E+rONDVYi302lUSk9d5tGRnm5ZUx9y6dWdcxZvGN34yFNurU9827oXE4RN7HSvwPYW2brb7WnsA/7NE52rFo/3tXnd9Vp1zUW69fofaf1Nl2v9jT/Smmu/rXVXfk3RTKhEh+i8hXANKCoFyopIzm545AqugDmpZTl0hKUhoeNiUhAZUgeebwA4TJ5NDKZtUT1YB0ABduVMVJu3nFSI5DUNL5F9acOWqojQpi3Smpv1V/d72ZrmSe/cdIjt9yU4e/ty/Tus/cqz1jzlil9MLFn984s0teFmldqj2FsUdUJqptAPxdiYNt74fU2svUqFN8MIeNuCIosSqS15k4g5JPDhCayhopXZ/EgeAwRskEauIWTOMPDICIMygtQWZgwhs9csuv2bDKzsjxsY8Shl5jVNX0tGO9pwU+/6156z8c3W3Vfg3Oyrte903W9esubzt1xzCanjG5nqgnP5ZBaZsQhXhvz7qp3eeL0233QZye2jX0V9EhRShAdmDRty0AhvOVQQi1YBWdezCfhVOcjV93oRg4PDrR8JmoyVqWnQYabDYZQiWqxB11DRcfiiRYT8ElsIoSl9NRyECy6ZftcLz1jz59pHjVD20cp3suzJH7r51NU3XDmnG86uc+tkGqTwT5hnGYBO5dLqbb6JA7DFAlV+lK2KXAMYJM1Qgewg9KFqHVZHoYhIDQ+JIUtVZvMEM/XNNMP68OgWKcKYBQDxZVDb8IxGWMdgHYAKXHlT949e+6Fbfw9qr3eW3+trbnfBz/2fK87olBFFd0wqXRLaSWCQQrRGEQ0zFXBRSGYDrLv6IuUlDZvTgJy+LQ5puVlGg10bD4gIjyD0LC7zkFPRs9i0gcVlPzkHinRP9pVXu2PKk1UV/CgBnMMQBtGGM6iQ26TPJ50v/6D7189Zuepg7eXGFvfyittZ7sWnX/O7DQlRjEjRFr66UqKFISwFUTtHgBQVddTpdtX0N0tQQkrKB2XwPaFyIRrUNmcciBjc1sFbAeM2uC2pFbbwg8mE5QZ7x6UnpKwoRQQgWqDMRAeDVxT8CLBPHzKbys0I0MenP9HctGnsBrP3JpS9udhdrfWPX7jmk+K5mVewn/MUs5BUAW0Cbe1w28KZF2YxOLGTN//cqsoBngYtFBI+nHjRIqCZxeNDoBEMFEAG8AhoBAG4ZyiWmfCBRL5VRvXsC3BUqQYrkvZgjOjy8EBbBvgFlFcDPsZK032p1xNfQUmTfFJ41Tkbj0dzr3VndK8ttr2Fnv7ay56+dCm3/ejLt0rlpUXiRAK5GwiI4JFQOirGVbZxFfJBmZ5YpxrBGcKOSjjJTCLfgEfdruHbbCZhlzDUcMHM5xkQCrgGR4UB3YfFKjg2U1bx2kZ8RmR/EhP3NPBQQEgCb0SDVHWsynjbWKv4hlnf/Vn9OBq7rd+do20zeXe6e0y+Zcvkl/v8fp/PeqxBdkhUVTsLXCJMMhsUX6UoIhTwDAKXG1/A9PtT1Cbk5DKa2wLJNm2oqW8MkfEqXLR0O2IOj46AkR4RbWiCEC3QAQ+F3EUDy4hg01u9QDgEgYsWhhqqnCCOqinhPsFe162X/tM7bj0WwV7pZa+scheLvPzPrjz2+tVVwdUdIpzMEEOAQ5sX4AbRQiGUVUUzyuROPjW94SZLnUfVsDCSNioG21jP+sZTEcKPB8SyDidIISXIjZfOJm/Q4juJAj+GZhqciqTtw0UVLdBikgvc2no1A1wvFMzo2FsBTyhSQeZfQd+yqb7bGnsDWHZvLLP9Na5Z1f+SExUUWT4EBq70YFYQXsQ2xsZDEQZkikx+O1RNr+MAlFAEQPpbw0HioSMZ0CB0BT9QjCnAjSMBD8DcClILGDPdBc5HFDhLoI+enzOcqpIMaLr1EnAeWDPBDYBuAjCVwMBNTYW507G80a2byrPA9kove2WV7SzyyDffsOyiy7cs50GIRqi46CKkKKQN8AxUDoScYJJE7lBnJOlZAXjKDBZJU4ripyxyKItgqIYx5EwpyaJhzYsgLCkHyVd0BARKeRS8hsnKLRueaO2ENJHAFL/byNMHXEvsKu8oIPSWG2rngY1DMcez7yKI1SUHLzpzw3/RXmhEvxdW2c4S9eZbPz1rtFFeVehQDykKdGEOBYmoQImQ+LgnZIqQf6gqvABcSFcjFByg6U1rhIK2tjogqzg5A3ZIkBEUFjRxtEKsC0FtdGfNBUKMbaQ2AySHYXBQEGAWwKDbEWvQFQGfnhLmVhTJb/3ip1GG6E8IF17R/1Dq7uHBO97DS2zP/ac6q25unlBdVAonruIAJIcUGAEkLaKdJeaUFdmmBQoopcQ1qJygybW/kE2K1Q0UmtSiBGJaNM8GVwESiVLHlyG0fRlAuYAr/gymWJvJujat6FfoSAKE2TKcKfiRAxExWgnxDC8GDHjWN1VTDwqfPgClxvKVK/f8Xxo524Sx9/tJ733ChWMjHUUQQkJIzOHKRYtXzyKBLjx4BVcUFSDAQ0Xhx0PeHVpOM7VZZaRIERKV8AhlFDpsMcBJ9kCeqjK7ypdgKwGnwxZqTJEurRsB3nIUzDMDRNaWwT78ByWwFOHRitVPCPxtpVvflnH5e8KWt035T9mvO2jz/zZrT0LmZk8usD3fn/vK2uP8vY/IBZ3Jo7VD4QKTNDDyE4OEhQK+5AMRTISedDuT2laXA9Gb3IwWOsIUbmWGwVh5n4dCxDhggdFRk1izIhMtAsTFMEDbUwtJ5GAVoZaEHeCHjlrLNN5wV2q4pId3iyb9IckeigAEeAaG59+fHv7p21PPaX3v/LijFmRvR1V3n94fvv8X/+Sv+6V+65SNy0BSWobHkChwGMiKZxiKCAU0A3hhKrCBvAswh7SZbwXbpFMLClNdAC4wuw9o7usWyEOVORUuUM3CgXnciiunIQC4g97KhFwzzUYQKQokbQwuOAQdXsCzGhAAXb4VhBwBA904E71iU9Vhj4ctHtELT1/1ZJh7rBPZHvN9p44fuvKHox/6p1ueX/s15TFIcCYgB9iIIky4OAbCNO1ECpxi+zGg5KEH3+8EErikZss6NSSw3yhrDYuOU0aljdKLWDvghfwj+WUUV3JrOdi3BDIjQ/BhMZgmHruupkHCPMMMosQY/NFQrB8R8k9qYYIpcQaLGfBnKbFNT/W0qT/yz9bbU+DV9pTvO/V76NToKYcs67BF7xwV9swoKHiRkDRZCZBwqUhG9edxqhNh244ErpQNthBS8go0L5VNf5qEtkXBlWYahFXlwTAQeH3lOrZR+6hQchmruIlQJA2gKmxrwL4CZiQPbfdW5NEHODUU/mENy5ODgUm8mgXU9O+1mqZykwj96Oea/7xTV8/zEnsCyNaecLs9nzUuuWz6f/b9pXdYJwcjpIYJ0gkJimsgBSQlFEk7kSGRNHF1B7xCoYOCG/edJDVQsd3UuuvlL1Yss8+qtlWhVY2jyMR5UOMh8bYAoK4JU6tDEOCSl867hBFZttVXuvQADNfDm9qGnhEL7CztYfB+YHKwfBYfc+YqHwCL588u2jx37C1o75G+Vw/A68++4eXzxjpy0eQEOofatsEgSRVZFR+5KLIotm/vNbAzHYGUhFZqlBA4AOiQJK+Ri9Rbv1odvhQqANroWL+m3An3M9ozXGEKHxV8M8r2LWqPyfGQUDM+rFJUB7o1ZZI9eQzZPkTLQXk1YyXM5dlyW+UnBYjE0SVCiTmCqDkBU/y6cPWt02/UHmp79QB89d83fcB/5h0Rci29aaQnaQAAEABJREFUUYM3XxnoikBmUKjw4xGUHhJ0AsYRJAgOmZWhLVpFzynka+HoaM5YX8EB6nRChblEUQAKbKsGDXyA+VBIoW1by5MizMcoACnpjDlJy0RLgvo6Bvsd8mENpajYTswSOvhNmlt+yzO3hU5H6nZDWyY68dz3TB6jPdDKHvB5py5ffeY1//mmdf2O8y82PtysN59pIhGeqy8RwCmsPIlFC+sjl+c8BCExR0RyhiNMruSa8IAVXR13ePdfuqVkEp3MKFU+KCioYisa2oxSSEBVW6oAB9Ap2IPJEplboSCGdnKrFUlrWaENXqMF+MgTH8gsN6t1WtO2lJARjoSnBPMC/tiItHb95Ae0B9peOwBfvmTi3C4FyD1Uj2w4Z+PKDecI20REUSSYGwrRPBigWlMIdAREgFuFuRkZ0aaRpQ8555RX/Bf/pU2BF4Gc7sRX7H3rzavbDOwET/jx1BZGWbMqGlc9piB0IxGphgaM9ijMuDEHYui7nWFu0yNxe674CeWhZNG2+IEUjDX8KcYvhP6DkZtW6SkI7rbvrELZWYNd0X/qC3548Lr1zVJvl9zgoiZ4qyAiA6psWDA8wZA1ZCJB2SJQMOaCOPISilJQA0pXpTMqdcZE+ia//4FfuVw6f2rumNRvQv4PRDR89Byu3+QKoQiDnQoOq7Yd3DyKSwVaG2jLIOgo267ADKDtEVtxCZyOolpgovtA4AYsZPX0pUhaMJwHVuXwMaLI8inrIjvpfbecArFbu3ewWx3embMNS2d9e6TbSA3P5MFtXblnBjYmiAJE5GhSWxs6Q6LNFsWBV0OhIgUPyk5XwTdLpTtHo6Oz9RuPPfQFGrSRmDh/Ykryv+HzY7ZlV2yl9soT/gwDnqTQoOUaLe7CGQuEtkOEUTUrZ8vrYAFUZD0JjD4zo24y7z6ymSkX2gBNioQPb9OAikiJ/E/VO9HoG1fqbebtTiCDu9PdHX2t/Grtrl7VP3yYHA2SUskg+TAlt2qCzSuCHiqFWbQUhARtMD9f5jpFUYAoKj4EfCRUGdXs0dAn3vSgmS9PHvGA7mcmJmreBVzpYIgIdfBXAFC/Qyr4QUQV3B2M1AqwMAlQJvmKNHCJprpoEVgXiVAU4TnaGQIMhuyUYTCZHyZxyuTRvgdSOPRt5FCq3MWiP7rkNWf9lHuaObsHCHv3ONqel8u/dt0V8t/6WcGbYvMiU2FQm9zcPDK+60ELykV3VpArixRgJUHqqEZHSijM+AgmVVQbHfOg2edrm3bWycv+Nvgo2EG1JAR+sMG/r1qrgmJtDD5TAA7Bhfbn8SxMMoWtaLZgCjOZ6ZHBt7RtW2AvyGR1RFZnopgwUGAcivCLhJxUMKEYAY0tavJ1kZ76jSbHVnwH9m7rpGS3+bqDo+e/67oln/3WhsOHaQ02KLExdhU8x0XzPuEoi+GdwnM37U0H+oGdQcyG4FBIDt0QEpVqphut39TTJ//4/BfZflt45ANi46zRjjqdUIQAPBOD18gCgxMAvcotx9SDYma8TQ+xIyvZzhKc+mte+5thgYRl2wCrYhmKCLiRc0QIRG3D6SAv9iUFPx7h51Fp9Ll/nzxOK/O0aXe0sjucbNfH5ul/WLLQSwQqhS2QODD3yiOAjMNTQpsH9Bqx6VDhco1obRs0nJAI+AZJKbdO3vqL+vAecPjsH0sre6C36QvGdXyXQ9Mp9jcQ4acq8BwwDNtO0d79YdkCahCkFBEMdM8CBxzbzCOuKltFbn4SVmMlWdd4QjWlO7SKsLbcyvuSI3TYHT5BeV42v+gVB23cbb8g8v7a1fbA+NULNz+1clgrW23dG8tyUnsqDZPtKqIouKItrSROUE0l55WBxFkHlkRCBC3rAEFGCi+AhTf/whX+oEMX/g5Kd+hHrFv42XWbp2fWbL0O1fCePdqi49eSOlhnGE/yiMdFZcIXkRixHsIALBMIHYpOfC3OivSBajuZRsUF9kVv0pBBoGG74liAhnUyH+DTvM9ct1ZfxHS39LJbvNyJk+e+5WenL1/Ms5qi+Y8bVCk8t2pfKd4we5GTpW0bB0EWsPuiUDFdSREJEEAnNfhpEblVFXW5Cxy+bJY+8cYVl+pO2sqV0Ry5JNRr7AuFzLQUESqsRZfwLBAXsRIzKKyqcOahfYtHCS14tuOKDBvDrHBFsX1XgiRUdByj91vtJr3J/kWb2T+MWpHR7arIuw64AkLDFvAdhv9y3vv9/hVN99dec8t8bdN2FS27anh3dpddPf3WqcF/xDET5CSxc++XnJAkNhg8Fkim2K5olAcsFAEWJM488FAHa3QxzoTJsj4+OAxkxs/2JfNnPRX2dvuiWZOn9Ho1//FFw0EIhbKT+YhQMAv/ipBkkDxV6AoSBvAIsGD9qhxAxbYSvM+IUITjDylIrycUwjM2oPAlwhakgoOUhwtBcNDYpQqxBPreKxO6eMbAdwIbLeQXREcc2XmzdkMjwt3g5XYuTjjjurdN86XLDJudekNFoYgiARGRWeDjragkvPDeEs0XM4WsokBEQjIppbWtZlbM+F6h9qd087ot+vT/OPJruou2bOmcv9nC9wF9ip8J92r2UUkudkySg+FOZZGGzYUhBvN8d8gAkUWYCUIPx+UZaOXVEQLMtjdWvb9qDcHS0LzCp+5sxt06+EXNUYG1xa9VwU8BbNfnwrr6Br0pnd3DodxD+zs1//r3t7zDt3onzbuN8MZQZRYbDtDspoeEN1mloAhmpQW03FqGcsrDQ9jc9n077NXZet6TlpxjtbuCD7x6/i3jI/1ep1PSj3Vzea/B2k6/kpGrIGZGFsQrZkFG5ECNKQ8HxWTNIa2xGXbrDXktbjWlE/Oxl1t1eoywhHfc8iucYEiqhiJCKkNmo8pd49a1oee9e+PD4d6jbrf3yMHtjU987/XHT0w1Cv9EK40I4i9sNhThbRkEDsiN3YagSQKor1AmZ2qQbCi6rCMa/iI6is6omk6jdYceejLcu+3PeczIqlldqdMNlfBatb347FuR68EWZ0xDwiIDgcCTArUWCioQrTD5MFAQraKeAlheBz06CZjhY40NsswHJu5pgi3HoYFusWRiagcwxcyBnTVStWHj9D3+03HHYa+7Db787U3nRnBKq5/RVREETOfDgMh60hEhtp7J4IALMtdnX+BFrZTcJZehgiOkkxohL1IZUbc7ot94zNyfnP9CvmnS3bcvfn3LgwtXT/4HKJhxlEa4H9xqIU0YApzu2GwTpWVkDJYTiQsUFFCE48dD9WawqRjR070Pc+pgE3AiGO2LmV2hHTZPFIncWl8YpH6KlH4Q+oW60xEHt+rGm8uvw7pHndDvkf1tjJ9/2uW/Mj3VjPn2H0gMYh/hjQDeGFVH4h4e2AkKtcWdEyhU4g4nvrYCbIyIpBX5v8b18dcdejTMHeqXfOLgTYXkd6JgH3JsHiJCEdH6aBcCH9BW8pK8hLW6QjcxDVsoZL92kebQMsDw+XA+Wj7cANInTrnM80IQ/lB0kZ2jVjcyB+2y6NLtksCFINcrVO+VH173x7oHDRf3wPp2plfdoB+HeuqwcYscs6+Shuel8YiQDE4AAJV0W38oZIxsThKIbYaQNJlpE4RXXgBnzxn9nnayLV0w9d0+zuzXCWTJAVUVzgbrbnVZQc0A2i7ChqeBjWgIGIeCiEiZ4+QkI6mKCLloorEF+VOI5wofKVwJjXQRYKFhG0pbOpAZm5lx8o2fTL3evF0Fb3lXbW9j9+r33XjsTaunFaUjXrQF0kIGHXJrkyI4RRHwgIhocbF/NkRpM28BjQiZgFa/DCrkTwmTvUbdg+f+Z+1kO/KgOHdqsuavhx1PwT5KiK52zRyJoSobk/V8JVZrOKgUhIqNOBGWC1kkKFswhulghYAAT70qpQt4SYsGA/bMmlGwge0eCnnfIalxflBMO3Anujc9Nu/lZ18/B/Eu9a0r7ZL5VqOrrp369xG+jSMfhEy4dHY0o+BfgZqFEB67AKmA9cWtsMJ1j5paRkVemKGzMzjhBo3ooCUd/cdpS65FYaf6h05ecs4Uvzfw/zegGawbDgL3UmKMxjTTIkIR0dJOvFo8UQL37Nu8FdriSBH44l2o4e7nPKQFg2/zpkWDVOI4KIJy4ZmwVEk5BLHZJ8vAGagTd0Oe6OqgWWL+zG8/U2knhrITuttVPemsnz/0wksnZrFn5QsPQTt0wsWmyhuqYCCMrcQy8yOg245s0EmI9Ss7DBDEeGxlwdtk6Xb0K0fOel7L2fnx8GVxa/rFv61rG5h892lpj1uhDtCIjJiawakGKSIASeEdwRMtcWaYEVttwuuh4n8dxGSFBOMNq2t4IrFz92HBHB0io+iDJX29qIHw2fIfuXzhwv7TUdqlvlsOwGVX9j8za3bDY67vLGQgPrUtMmB5l0CbDjLEDiOY3ZnDNPK0AW9nNg6vZuICVknJnLGePvGG++3yqX/gwZ33sCT+Wv9UlI5/rwM3O2TOOdRc16jtItiF5eGyVbMT8KZUNKsyuDOjLUw0bCH/QA2YAeqdRRiDwM7noaVCEQb4Cg8tWAelIIbxTtUrz133uFawc2PZOfU7ar/sPdcuvuzqqQep30gEqkELhQQdPAOL5wIt2iBwMLp5pAeeDwyTOEWA2lOTDAYfdTZrZnSk8QXdnX7243Gmf+4rF5w5xVl1bGZSI09yNIl4YNnb0KzvGDkpSCthIuVupIGVr+7C7diz2G/LR0+O2sA+o8qy4KBhbaakkNV9eDxHBCwoJrRZDtyI3MCbytoA8lSNiqDqplvjsyA73e/xAbj86qn/PT4rFLz8MbAZcIcRnttNtyEyBoI8CCBkvXLL861skAmnOFE0JVREqyCVmUyIF3+t29ToO2ceeY/+1ez1//zczYcubhQRQDrHPcklgjDpwQDuySAxOmZ0fBAqVx6VMJeY2Sf87Kh59hRRFAZBYZs+1LZqHoqEwNqW46MCiC2DAya0wFCqgADcYaXbNlT+46d12a78H9DKbT3tPHXN9ZNP5FCqEgQ950qgZEUVd1HNlcI/ZhhEsw4QRpG1PRQBwLN9MLcpgYLfb4p+++kLfw77Hve54/FB/829y946YyViq8TbrtuOKYPvzUSE/JO8hhE+XbClcIzVk/zPu5XMrd5Nh9rGEgr/oJOHyc6BxGvFEZ3JOqgl4ZdoTgpnLuRPBWoFQgiEFs4q6l+59i0QO9Xv0QF40duv/VYpXWIg2uFtOjcw3Dh8NhYOCX7mjBkDONaxvKVQg7cVD/F7MRIkIDj2UTsKvsK95aCDH6zd0I5a1nxsYhJHrgYT5RdLkeMqf8x0mFkQVX4cFzNMemqnMthAklgIL94SQE+7sATHns3zbJbtPEcEVrZjTtxcINBgMXr6qWgJueD7zYNA5bdBp906/vP3m9aXd2C5U32XD8DKlV/tXnDR5OMb35cHIbYrhyKAJEKiV9GY6RIyBkmRP94I29cM27sJpUcmRf6YLup0Ju+YA+4AABAASURBVG7ka19+p6d73N77qqX/MclnwQhWiNYdqAoZ8ewVk0vwrdhjKKIqhoKcWyrg1qQ9BOZQ7t6PwWxmWKmZh8s0wGUt/1p4mAfPQkuBHzLh0eBc2Y4QJBg+u/ZnsOrqtUV/cPbEA7UTje3uhPY2qtfMPfovx0b7mkkIEXgv3gzXikSAdMestkGlTkothk3oyWvzlcqoseeWgRgk2X2+XXrq45b9Hka7rT/5mNgY3Gla0NZGDEGEYQ5DhuGgBnhLQ1gO33S7q2Q4ZGVx2NuAw2T9ID1o2gCOewQ81rJBBRe4xZlLGQsJXjqVwKDzBGjQKjygSrO5Q95wy/Q5A8EOTbt2AGqNT1+w/vjqh3+7PIuFwpeP7JLbNwE5frht7BUGEGi6oj7JwjaFMEkLJEjyWrSCD6E7VvXR1xz8Fe3Gdvl1/WdV/PWJi56hiDUdt/lyS4ToPAOBnAkJPI8Qfh9sbSDg2ZFrlM/tVgCXB2CkBByEURHyS3CbCzMELVXEIfyD2ONQHmGu9VBAlhg8z2jzQazRdddrp74TcLVsv1PwxD+89r8unNORwuahkBsh5AOJjfJ2n0XOLFjWbqoGmnQomGyNrNO9Vei2p4oHxHYcrBEcrMMP6Xyy1dh946GHbr5o80S/DYc1vaS9g3oirpxa+TaotyXlRriiEYMObaGQwBAYirlnpwmucwJb9m+NIdyWZ08udLR6+LC+uannwUkLpZxV0q11Esj9iedsPEU72DK0HdSdUVu9atPf9nn2V7+FEAgldxwCVQYB4jkz6EOBJSwZlCN3CArrTZkXNeCGxGh1n3hYcvNdZrpXNb1s7stN7044/3WHbVk+N9ZHCXUIuMMcEYooYlLbQiaSDkdcTQqusoEEVMqr00DxIiUcjkACPtwMqBmotalxIc0Dcs/QdeDIj1Z7qxV/yANoKy1FhEJtq3wXEWGqJs97+N6VzZ+00rsfy92r3FbjD874xcs2TQaL1YGgDvBI2oehkqgK1XLaUWiJbZvvOW+PEHUIyMy3Wu5HScEtWnHQqL75xmUbYO32/tijOx8ruSiuvTDhEhKEZJL8yy3CAjRhWG6AQ5DGAPhSKNW8KQUkIFQANsIInbIWlZVBsWZEZrolWprRPRRy11A+0AnxQ64HK7CEL8lG6zfGouM/vmP/h7KinWw/+snmj5T8+wt/GKl5KIcuXHzHQ1gZ0yDO1GlPOJokIHHChRJ7EBecIrS1mQBCIXU4AMvLDv3Fz1YHO46971XzTvEyCcTmwFlaEWFUjDPOfFWy4xme8Ype7odbl69V460Bu28AuvlplM4YzAMyMZDFPpw4cgKZd45cHEclGZoxL+gmIfG+4AhahXSX9qFZJLS7cdYOfTO4UwfghD//2TOuX9NnfS8q2TgIpO01aYSEAWcg8EuO4PiKN8sz0uy5F5JeeW4xwWu3IZKZNjibnOrpM39y/3v8p084326fNVJrOHoSR6i5fHUoJZQxys0MKaRMPJOElVIx4PNYS6bAla1iXGeoZMkk7NZUbatMASgRBohAMcwDhjMoKlW214DpaeuhQ6MSVu3p25f0duhl0DXEasf6JVc2/zA2ypJ87Rskq4KyXAbls2gwbW95oEEK0dJl3Qa6KhRhGGiCi5e8sIxkVt4rqirCylutdNyDeNlEtif70Yc2X+QXjJq5UsmKwxquSTSgjtAawVEJdEUbSHKz7e7YAmdiK98WMNiPuLJFY3coVXsISLovijANLuZcG58RIRvmZKxKTOJ6MVuoyojllbuNrxu8wxPvNKN67UfX3OWfyluRrXraEaijv7ixP19UMlCvgIigRmGMBPPYm2Oymtx8OitSAexJbtYxwJrRMz8isAVaQtHhK84FY08zuSeh159++8Q0Sw8XyeCGhFRKQJBaMuzHwKCS8Fobcq9qapAbhfUpvZmGKBIsowbR4MCCySjL4QV4MNtZxVd+IwmPlc0FhtZetxJGu4Z1FWmJjmSs2626bnX5O91Ncxx3o9KKn/DKy68e6TSqvP0HV6lz4jXbG1/IeBaYwCsm1QOzFMpD4Cx5ZyHBInhJ5qGIBkQ7CmFEMBZN90KffPNhF2gPt0++6aBvsSB3HHZD3F79NksSY9LEJe8PyEcbdAHoiAMQbnAg5Z5zR7BdwMwB/EBDJcDorarMygH2jB64cEzHlyRo43IDgfQiZpvDXAVbagVUSPrBVb27/Z9Q7dABOP7dN47/9Lr+IZUrQLge5sORVYmcsMUB04c5rxL42QnIgRlMV9+/rAuDbpbsAy8Zu5Pm5PZZ69eOGVmXCnthOHhRXC4icGi1HaBEY2+M7myFWIk2TzqU9eCAoVuB4S6sLTIlp6glBlI4ww6ntrKBn1zXHNjJwnfLIyvmYWFxC6zqBAJ0pQgdTCQI243yAn3ihzedprtoO3QAFo3Wa+bMRpU1lauRFEc4vII9DxdJPgTBoMVmGY2nXWAeCMXFz90EXVOhkLuDRlXOmv9lUSc2LNdeag9/QP/9I9w2/Sfgha06Hi9dQSpXvDxLjJF3L+4V8pYsN9dzqmnQQgp+RKuVIaQICikQwKOgIxJTNuOGrKKNSIUFLQoGgtx/Gp5BcBDtUbgIFvfHb+cu8wjd64cuvVb/A8Ptdm91u8JW8KnO31+wcbHxkpmR11OGFgSUwbYkpYaCl/yWByNV5SsfIsLRSsFt0ECcsgJcRTBmL5ozKp2/8mG75Rc/LHC3/f9+56cf3rCpIYahaqZW7Sj5ruTkWlqJM6ESLNsV+zLfMMxBFp3BNE5SxYXBArXkppV5CXBTKblg2JqVBRrkM1gvdb3mEOy8sabA7D2481SgZV5/M/MTtv9fGk3/uov2nNMef9r4WFUEzgkgFBliG19gCW0ZmLs5aIPWBJ9KNDRUyUTiIbjFV89AHeB+NpZOV52Rrp786PFv4GCv9QvP+dXpo+/HcoRNp9YkzrF5QwDnFSFIjtbQzJ7Ahl2RP5AhiU2XKHmxCjqCTJA4W1dm3MNOgdzM8hwRCi42RpFys9DjUAQZQ8m2TMk3joR4LROFhx22lAofoOaMSM97zuht/qspaMz0MoNtB/nBZZtXNv32ds0ScvDEoYhIC49sS8JTKCQiTrlxyMg5NdCvykTaCRRR06s1TAEhBVFHT3/5R4c/SXu5ldI73fE1PNIqa2eSG2ICl6ME9YGuxhPgmgfuQrSHW5mDyiQG8xErAkXzDPAlckKiGkpmHbMi0AkSiQxMbuF8wk85DB8oQYNm7mzbQHjtpgFz0AZ4radGP19Vt/v/ILIOqnfeTzzrxpfWPjKuULWICcnRDRZpj7fYNOBumcE44EMj2xtnM2nGBqqdQMszdDpoelJ/WgvH5T/V0N5uBy3o/9WmLVWZRw6BC+jQwjE6mOpBUBVo5L1UuTFaERSsHRHWdABJd6GYFDHwFq3mYLIo/Q2Gdopk52DUFqyaqUqmghWQWJAAnTNSz62U0hU9a2U9Cu4d+l0egMuumDhvZIRThVYEC9kcx95Mbs6bhG6jNWKFAXhnsGxVbWvcPIIaaCi4zTHA8StVBzeh6X5PT3nU+CeGOntzPu91y6/YMt2+dgSBG8gxIRA8Y9tJMswKpLzCJQ8FuogROyHwJAY6CtvUDH3fRZIPLus6D2TBWplb87HCLVwybURY1OB6CwkbDRrUAGPK/NoLgA8f5IaDbJ9TzcY7/efzBbM77U949TUrrrxukgCk4Ad/8roG0QZrsRLEsBOoFwvTBOuJqrY6LRNWVZtCo5UhFNz2onRVOqOs19FfnHT4iQj2SX/Oo8cuHu2GOp0i7zXkNiwC8dLNMcygViTyLCz7bm0YUSD/uf8Y5MZ2gY4Uighlo1IhfpKOZHlgVaaWxtwriBPAzEUJ2+oGQlXh2VUgivn4sq1tcJ3/CuraG6ZWPHVl7ep2rdyOniEnJ6c+O8rHIgfeFhGXeKTL8VcWczAJWFV2yn5lNprmtOCAAgmPAR+O6meeo0pH5vOMQSYeMf54c/RRc67E8C77b5+97tde89ENH37J+9ef97Kz15/33/960/t/7yMbf+MujXZQeN2a5rndDkEr+KF2xOm4vS/BgVTbop3kPYAyBfLMB3iiIU85OF8B1fqptrJzOJKCMtTQ1mYHBngsaMyKUGkXJoZMjJxOCwK87Y1KtFR1vhGOdosWL5i8w7sAK7cmtx9/cfP0o+XCpKNQREgO1BNQgBgEDYqIMarcPLYirnUIJ9B8Q1gQ8AmqRqMgwOCXF+pPaXJqUg9cMfJW6xke+a4blp18ztoTf+Pt6z757HduqsecsrE+8OSN9XsXdb79+e90Tvrmjzov/cb3Oy/94rf1qksu0Zd+Bflj37K5Pvm0DSvv7LTb593B3B99+YaNkyLtkl+sRJy24XyDVbVfclVYDVAVgx9vq6YGbOaoQlIUgQbCkBsa6dk4gMxkdZ6xqRCwLGDZUMCDYGbEH2Oer/SNIt7aQFOACbN5wsK+bI6aXDabr17T+5xu18rt6CRfcdZ1/z5S+njklcPBhdnB4nYDzoaqFwGF63UGgQScVhLeDJI8KCpoI4uOqqEWfIMzV3U4AiW/hp2Y7Orna8ZGnvuutfXIE26pa66cs+orF5ZzVq2O373+hp46fBrxv4KZO1I1Z6SvsW5f3U4P39Pq9fuqvaqN6/r8Prz+yQ03rpv+3fes+U8EtFP9/PNf2D/qoN6q2gQHgJiZVQcu2LdYLRLYA3OKqAgdStkaxlRNIVu1g8wHArQi8JAyDxWOgEqWZGVVnG21D5ghTHJWbSfG1PUQJvDvog/x1INvOx9av2Vde2OjF71/zeGwZ7p3MUMMkc98Zf1jCpI0NnPg3GjLcxQABCLYVcGKYaJCDrvlbKv6CAIOLtAsxssIpe+oW0Y1Z8FBWnDI4Vp62P10zfUjn7j8GmmEB9tYlwOofhZ3muL3KXLD7yIq4LW6rDOC//HRrlz8qS1b6jMe1Xzj4h+vOugnH14Yf/+6Rbv0D0gOWlje3PAtmhNa2UM43pCYFPw46ZaxZbn5TuFtJ5AD64QJFCrHmytHCjIE2Na7qsg0aFZtkNWAgWHIP+DZK+Y1MVQkhoqi17SvIChLG3h2WRtlQ00GKaymCjG7K62/tX+mtmllGzzRh5646hGzRwpmRcK5AgeqInzGms4QQDNWaLgtky3l6gMeZnRFhMJJYAzklY963VmzNHvxYo0ffIhmLVumziy+9pPEu5c6DCMD6HQi6Qj7EHcJqTddVST5n3hPTDR6+AObKw+bPf2U8UM2j//sL5eX975swZP0b0etQmWX+0dft+ijNfryReA7GBUgetx5a7lf8AASryI8E9wFjYf8k4yUg9VoUwRdUQ40Su4iEEZiJXOptoGnxLpAhWgPXEU+yDM6ws+QH/YtL4Ny8sUdDN2mKt8RGimavn52g56vbZpzuQ0pjUzeelFw1bGuDBIOoygMGapyqepi5jPcQYnG3BqIQwyNnVoI3vDo8k0aAAAL+UlEQVTH5oxrzvJDNPeQwzQ6b5GiM6LaICewJoNsr4s82bhiRe4ORV18jPECU3iBnZwMPWBF2fzgQ8pbH/HQ5sjLzl0YH3/tgqP+6Z2Lvn7hyhWbtRvbWGnWdthzKaGIEIO7qn+q2gZbYnCF4KcahUkd2DJDRqR2CnKDcXY2jk3yrRdWCeTMpkWrVRV/kf6dd3jZ0Rvo4EoV3HOE+dYzheJgci7ZBnfVoIId/f45m2f+0zJF27QT3n3jkTdv9FkScbXW+FSEebkt2X1CgIoBWQQzrsMmBouYozuqscXLs/Aj8xeoUPRAr3Bl+7mUZpjae7DRSk6avPVai1U4GPPmNJsPWzb9qaMeEI+86mML4/MrF4z/w2nz3/XJP1x0tfZge9T9+1/g3MkFaJdhQ0YyXpAkIUCJNEfBq7DC4NzABU3MsxJjNGEY0CwCloxWSC6ShyO6tm0tTS3QYcSuJtxGxwTurMukQpU7HeXs//vIqhum/twqBkSeWrjm5qkPzLJiFG7ahRgoTbWsyUXgQCRDESGhJwpaI6CLgpUipDJ7nsaWH6YRil86XeFMLm6bTNtXoSr/a5hOqXJwnU7FR9XkdKOxsd7PH3dc87YffHB++ea7F41/9m1Lfvczp869WHuxXbt2+tSJKS8YHrZCBTXLYNQzUAFIBT+5TwokmDnJRuLqrkiVLTxaiMzcxvQAIgoYuUcmgQfkoNskBnQIHV6kG9YRuCwUDQW6Cpd9BDr4aUUcGZBfrOo/Hq3seM85h4su3fxbvEuriYI7AGMLvKGqNsSAYcAPGzIR6HaA0Njc+Zq74kjNmr9IXRS6TUWhenliC/lZZI5nX+lj3a6mp7CvoSccN/v8tWMb5vzsvIXxvTMXH3H2yxedrnYF7Yv2pTNWXNPlW9BMgYMmRiJVRBBOKBjZFHtCSA/kLVNMKZXYudWTQscqCCWYVckdjBVVg3mB1TBnGvArepZJEZ6DGZFoYRkzVjmSd6MxXCzMNVRiVb5HNTx6X/WRjW80t3gwPP31P3vrKBdr1GlVvo6tfDFTuWyrvaXTIh+BRgEnGEMaBDNr7rjm3W8Fz/b5CrR8RRd7jpr/ULbA5TDmM6jXk9Zv6uthR0Zv0eL6+yuO6C+8+H0L4oMnznrhdWcetkX7UVs0Hl907LnNbeJyTpwSsywL9pe9wkHgj3EzZ9c8K5E1pJyZUPWFgV6yzcTYeOWdKnOeMryaGS40g+09eR7YFGazguRaVfhRIkTIupVPTn6/qhScD1B8mqqaIv+wdcMtNd8D7ENuq1br9C6342oHFI4oWbmKcGVeZaUUoWyxqlS6Yxo/aIW6cxdwuqwp5bMdP8EtvdtBh3l6qq/7LS295cvirKc+ovuYaz+2OD75+nkj/3ba3L/50psW77W/+tFOtkc+uHuuQuqzV1GUpuFFFTxgOhd2FwywGOlmGpIRcs4oBXlE5o4PuLKKMKwoVOtmQgNWWEsgLNdgh3UqgAtFOkzZvhTUBsCkEkV02UPYL4csTRkqF6UPJGwVPmFFJ7RiYb1RtALo+D+58v7rN+OdlzTFCCzYka5YFrxSSYM60IG7UJfP7p35y8SnOnHDkP9DzJUXOC/e9ELjI10tml8ueOLR3Rf95NyF5QtvnzvyxT+ed8rZrxj/Lgv8UvT3njD307duJPk8ZyupzZSwexehZiYG23CqoCvJZlKrZ1mViRpow7QaHMyrwj9hcbg28Hy4WEu0CiCvgLFK5YyHnc/wMEEYgDFWQBIcBOUcEYoIRFhV5QUqFQU19Bdo7z9p/kmiFUDLDxp5cRhBLJRqdNkmEBSczcuOSkfiiI3MmsNVfz91uhwUHPcIrs8tZnKyqpTezU88tvz1D6bmj/9/fzE3Lnjn/Kd98FVz/w5DNPVL2KJ31CGNuJiI3VuoCn5qFWPIzTiXq1ybiJZnPGGgEOQoUPRBkHVQc8F8YDxLFEluASZFMIeUJ8NrGRdL4KeS6/YRAqNRxpbxoWdfqIgaS0GPqqDCYSa6fS7MiYmennTsrGdq0BBLkxvjUj/zo/aJG03Kn7dylAJHdizeDeYtXcQXOAs1ayRYuGGdnn7zuHL1iiMnjn7xYQs6l7xv8bL3nzj3eJ0Tu/UzOWHss94p/XeMcdscBuBcBtltiwe3hESS6KLG4M6WeVXFyqJBWkfQeRC2YZmWqkSlikIRgKoiPCcbHrNoLFCpjfCT69dGFMICuPhQVQB+W/Pjd3w2HvuNatPTsx83NjF3WffRV3xkUfnAiXNn/ocTBWu9/9TD/nGE79cbDoBfAgu/nAk7x1kFOp2i7oJDtX5iVA86uGy8/yEjLz7m4WXppWcvig++cvzIr75x2U9WruQNRve+dvj88XOneXEiDbm58MiQdQePypCFYYYvSiCUYc0UxTT1VITLo2yWG6Q0YqzyHYJRgrKmJYaWZmTRpAeprjXU4wz4Ba/fK+o3RVN8dF2/ueiYI7patrz7+8c+ZHTZpR9ZHme+bHz2he8a/558ZWtrywNg8rlPWvDABeOhSV7Ymn5Rr88jgNvNkUcs3HLUsYec9ZRf0xOvPm9B/OOb58/7zBtnf+LTr55/i+3u7fCRN865bu2maXGBkjvST9KlqrzthstUVStghmcAtoqLBVIA1NVYTrJMMkm4Ei3PDzhmdtsCfOqq1MGgIDfuX5cXXuA6peBfKsGMfMukNHtO1YpDmn/9rceP/M7VfGH2t2+YF59789y/+bvXz79Zd9FmDsD/Ovngn/3gY0fHY45dcfRzn3nQCU954tInX/MPD4kL/ufBc/7tLfNOOe+E+d+8Cz/3atFvP65c0SaKcuXVx8yO81nMXChCoShMMsDKQ+FqZt1D8DksVLlygMKgoIACmJMW6taJPCyVjx55aLgTV+4lhXU7BDHKp6oRYJw79tLF9ZJnP7b7zpc+YFHn+2ctiq+sXPyc975s3j/iaYc7Lm+r+9nTl/3k/a9Yct5fv27x/72t5L5Lfec7a59ZSoeiBkAeKBijqKHcKpe4gQlWiIEeigAUWVgGQQoPEgVNnIEu3rXFxSwVX/e8h1W8ccaafvAJKzgQRRO8ZKv2Nj/tuFkXH7S0LvjOWUvia3+66Lj/dcK801au5HTgdVf6HQ7Arji5t9vMeeBV126e7CmvZgrjW76LLcoZEYoAapiUEAQ6ghSDv+722zw1RSKaBcO0o4hyICywO0ABGelKfe4A6zdP69gHVR3xgOnnPvWxS0Yv/uDy8b84Yc4j/3XlkvU42i19GMlucXZvdXLByqf15oz1V/vyzzr7cqVYLvbMYYCOyEERzBTVMr47slnyQiH5YqXoKaP+eZvnaFRu9T1+D3L4kr4OO7T8+bMfP3rs9X+zPD516uL4/KnLPnfOSTGtPdAOHIAdTOpTjhn5q24p8o/f1imlIgJazGobBQ0F5eRogLvypqOVCnX0izocoAJM96qCX70fukw/fsajR189+1eXjP7L6cviX96y8A1nnTDvhwOzPTodOAA7mN6zTl74BnWkoHChkBIklZCoLKPc6uDK953CB6XyvK8IgmPhl8aGK33h/N6mX39Y+fuHPKS77IcfWhaff/viY97zsnkfuPCkmEZ1r/YDB2An0v2wg/vnqqGUFNnP9k6p4qbg+su0oKsLTfV9ICIYwUc7/eZhh+nKBx8dz/zRhxfH1/9sydyzT573X//59Xf9EW0nQttl1QMHYCdS93dvW/LyI5ZOfbTTCY2OFHW4+v0CZ2godImO+swTfHN06LKqY4/svfyJj9oyfvEHlnY++ZZFR336tQtnvoHbiWX3qGrZo97vhc4/984lL330g+PBx90/JkKNpiYbTU9XLZvf6H73rx96xq/WR/3svKXxhXfwG883LDv3nJN275+q7e6UHjgAu5DRj52y4Kcf/aP5s7/3vsVx6UeWxKXnLo4L/mxx/OupC05+3wmLLtoFl/vM5MAB2Gep3z8WPnAA9o867LMoDhyAfZb6/WPhAwdg/6iD9lUYBw7Avsr8frLugQOwnxRiX4Vx4ADsq8zvJ+seOAD7SSH2VRgHDsC+yvx+su6BA7CfFGJfhXHgAOyrzO8n6x44APu4EPt6+f8fAAD///RXVxAAAAAGSURBVAMA4Lt2h6Ov81QAAAAASUVORK5CYII=";
(function brandMark() {
  var url = null;
  try {
    var bin = atob(FOLD_MARK_PNG), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    url = URL.createObjectURL(new Blob([u8], { type: "image/png" }));
    document.querySelectorAll(".logo").forEach(function (el) {
      var img = document.createElement("img"); img.src = url; img.alt = ""; img.width = 28; img.height = 28; img.decoding = "async";
      el.replaceChildren(img); el.dataset.logo = "fold";
    });
  } catch (e) { if (url) URL.revokeObjectURL(url); } // the "A" fallback tile stays if anything fails
})();

// ---------- DOM helpers (text only, never innerHTML) ----------
function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") { for (var d in v) el.dataset[d] = v[d]; }
    else if (k in el && k !== "list" && k !== "form") { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
  el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
}
function enc(s) { return encodeURIComponent(s); }
// In-page view switchers use the WAI-ARIA tabs pattern: one tab stop (roving tabindex), arrows/Home/End move between tabs.
// Route-changing switchers (project and connection sections) are plain links with aria-current instead.
var tabSeq = 0;
function tabList(label) {
  var nav = h("div", { class: "tabs", role: "tablist", "aria-label": label });
  nav.addEventListener("keydown", function (e) {
    var tabs = Array.prototype.slice.call(nav.querySelectorAll("[role=tab]")), i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    var j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); tabs[j].focus(); tabs[j].click();
  });
  return nav;
}
function tabButton(label, panel, onclick) {
  var id = "tab-" + (++tabSeq), b = h("button", { type: "button", role: "tab", id: id, "aria-selected": "false", tabindex: "-1", onclick: onclick }, label);
  if (panel) { if (!panel.id) panel.id = "panel-" + tabSeq; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", id); b.setAttribute("aria-controls", panel.id); }
  return b;
}
function selectTab(nav, btn) {
  nav.querySelectorAll("[role=tab]").forEach(function (b) { var on = b === btn; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
}
function linkTabs(label, tabs, active) {
  return h("nav", { class: "tabs", "aria-label": label }, tabs.map(function (t) {
    return h("a", { href: t[2], "aria-current": t[0] === active ? "page" : null }, t[1]);
  }));
}
// ---------- icons (Lucide-style paths, drawn with DOM APIs; no innerHTML) ----------
var ICONS = {
  copy: ["M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z", "M16 8V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3"],
  link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
  type: ["M4 7V5h16v2", "M9 20h6", "M12 5v15"],
  check: ["M20 6 9 17l-5-5"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"],
  key: ["M15.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "M12 11v10", "M12 15h3", "M12 18h2"],
  offline: ["M12 3v12", "M7 10l5 5 5-5", "M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"],
  phone: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M11 18h2"],
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V21h14V9.5", "M10 21v-6h4v6"],
  folder: ["M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  chevron: ["M9 6l6 6-6 6"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M21 21l-4.3-4.3"],
  plus: ["M12 5v14", "M5 12h14"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
  refresh: ["M21 12a9 9 0 1 1-2.6-6.4", "M21 3v6h-6"],
  upload: ["M12 21V9", "M7 14l5-5 5 5", "M5 3h14"],
  doc: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h4"],
  image: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5L5 21"],
  user: ["M20 21a8 8 0 0 0-16 0", "M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"],
  table: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 9h18", "M3 15h18", "M9 9v12"],
  braces: ["M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1", "M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"],
};
function icon(name) {
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  (ICONS[name] || []).forEach(function (d) { var p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); });
  return svg;
}
function iconButton(name, label, onclick, extra) {
  return h("button", Object.assign({ type: "button", class: "icon", title: label, "aria-label": label, onclick: onclick }, extra || {}), icon(name));
}
function iconLink(name, label, href, extra) {
  return h("a", Object.assign({ class: "icon", href: href, title: label, "aria-label": label }, extra || {}), icon(name));
}
var toastTimer = null;
function toast(text) {
  var t = document.querySelector(".toast") || document.body.appendChild(h("div", { class: "toast", role: "status", "aria-live": "polite" }));
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 1800);
}
// Copy with a brief checkmark on the button and a toast.
function copyIcon(name, label, get) {
  var b = iconButton(name, label, function () {
    var v = get();
    var ok = function () { b.classList.add("done"); b.replaceChildren(icon("check")); toast(label.replace(/^Copy /, "") + " copied");
      setTimeout(function () { b.classList.remove("done"); b.replaceChildren(icon(name)); }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(ok, function () { toast("Copy failed"); });
    else toast("Clipboard unavailable");
  });
  return b;
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  var b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
}
function hex(buf) { return Array.from(new Uint8Array(buf), function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }
function fmtDate(s) { if (!s) return ""; var d = new Date(typeof s === "number" ? s : s); return isNaN(d) ? String(s) : d.toLocaleString(); }
function fmtBytes(n) { if (n == null) return ""; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KiB"; return (n / 1048576).toFixed(1) + " MiB"; }
// .msg elements are live regions: errors (showErr) are alerts, everything else is a polite status.
function showMsg(el, text, ok, isError) {
  el.className = ok ? "msg ok" : "msg"; el.removeAttribute("aria-live"); el.setAttribute("role", isError ? "alert" : "status");
  el.textContent = text || "";
}
function showErr(el, e) {
  var t = e && e.message ? e.message : String(e);
  if (e && e.status) t = t + " (" + e.status + (e.code ? " " + e.code : "") + ")";
  showMsg(el, t, false, true);
}
function copyText(text, msgEl) {
  var done = function () { if (msgEl) showMsg(msgEl, "Copied to clipboard.", true); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { if (msgEl) showMsg(msgEl, "Copy failed; select the text and copy manually."); });
  else if (msgEl) showMsg(msgEl, "Clipboard unavailable; select the text and copy manually.");
}

// ---------- API ----------
function ApiError(status, data) {
  var err = (data && data.error) || {};
  this.status = status; this.data = data; this.code = err.code || null;
  this.message = err.message || ("HTTP " + status);
}
ApiError.prototype = Object.create(Error.prototype);

async function api(method, path, body, opt) {
  opt = opt || {};
  var headers = Object.assign({}, opt.headers || {});
  if (body !== undefined && !opt.raw) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && S.csrf) headers["x-csrf-token"] = S.csrf;
  if (opt.key) headers["idempotency-key"] = opt.key;
  var res;
  try {
    res = await fetch(path, { method: method, headers: headers, credentials: "same-origin", cache: "no-store",
      body: body === undefined ? undefined : (opt.raw ? body : JSON.stringify(body)) });
  } catch (e) { throw new ApiError(0, { error: { code: "network", message: "Network error: " + (e && e.message) } }); }
  var data = null, t = await res.text();
  if (t) { try { data = JSON.parse(t); } catch (e) { data = { raw: t }; } }
  if (res.status === 401 && !opt.noAuthRedirect) onUnauthenticated();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- drafts (scoped by principal/project/artifact; cleared on logout/401) ----------
function draftKey(pid, aid) { return "al:draft:" + (S.me ? S.me.id : "anon") + ":" + pid + ":" + aid; }
function readDraft(pid, aid) { try { return JSON.parse(localStorage.getItem(draftKey(pid, aid)) || "null"); } catch (e) { return null; } }
function writeDraft(pid, aid, base, body) { try { localStorage.setItem(draftKey(pid, aid), JSON.stringify({ base: base, body: body, at: Date.now() })); } catch (e) {} }
function clearDraft(pid, aid) { try { localStorage.removeItem(draftKey(pid, aid)); } catch (e) {} }
function clearAllDrafts() {
  try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf("al:draft:") === 0) localStorage.removeItem(k); } } catch (e) {}
}

// Drop drafts that belong to any principal other than the one now signed in (identity isolation).
function purgeForeignDrafts(principalId) {
  var mine = "al:draft:" + principalId + ":";
  try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf("al:draft:") === 0 && k.indexOf(mine) !== 0) localStorage.removeItem(k); } } catch (e) {}
}
// Session ended (expiry/401): unsaved text is NOT destroyed. Drafts are keyed by principal, are already
// persisted on every keystroke, and are only re-offered to the same principal after sign-in. Explicit
// logout still clears all drafts; a different principal signing in purges them.
function onUnauthenticated() {
  var wasIn = !!S.me;
  S.me = null; S.csrf = null;
  runCleanups(true);
  viewLogin(wasIn ? "Your session ended. Any unsaved text was kept in this browser and will be offered again after you sign in as the same user. Log out to clear it." : "");
}

// ---------- shell / routing ----------
function runCleanups(discard) { var c = S.cleanups; S.cleanups = []; c.forEach(function (f) { try { f(discard); } catch (e) {} }); }
function setCrumbs(items) {
  crumbsEl.replaceChildren();
  items.forEach(function (it, i) {
    if (i) crumbsEl.append(h("span", { class: "sep", "aria-hidden": "true", text: "/" }));
    var last = i === items.length - 1;
    // The current page is plain text (not a link); earlier crumbs stay navigable.
    crumbsEl.append(it.href && !last ? h("a", { href: it.href, text: it.t, title: it.t }) : h("span", { text: it.t, title: it.t, "aria-current": last ? "page" : null }));
  });
}
// ---------- primary navigation (sidebar on desktop, bottom tab bar on mobile) ----------
var NAV = [["home", "Home", "#/", "home"], ["projects", "Projects", "#/projects", "folder"], ["connections", "Connections", "#/settings/apps", "plug", "Apps"], ["settings", "Settings", "#/settings/device", "settings"]];
function navSection() {
  var p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (p[0] === "projects" || p[0] === "p") return "projects";
  if (p[0] === "apps" || (p[0] === "settings" && ["apps", "publishing", "api-keys", "tokens"].indexOf(p[1]) >= 0)) return "connections";
  if (p[0] === "settings") return "settings";
  return "home";
}
function setNav() {
  var signedIn = !!S.me && !S.offline;
  document.body.classList.toggle("signed-out", !signedIn);
  navEl.replaceChildren();
  if (!signedIn) return;
  var cur = navSection();
  NAV.forEach(function (n) {
    navEl.append(h("a", { href: n[2], "aria-current": n[0] === cur ? "page" : null, dataset: { nav: n[0] } }, icon(n[3]), h("span", { class: "full", text: n[1] }), n[4] ? h("span", { class: "short", text: n[4] }) : null));
  });
}
function initials(s) { var t = String(s || "?").trim(); return (t[0] || "?").toUpperCase(); }
function setWho() {
  whoEl.replaceChildren();
  if (!S.me) return;
  var name = S.me.label || S.me.id;
  var menu = h("div", { class: "menu", role: "menu", hidden: true },
    h("div", { class: "who-label" }, "Signed in to Agent Library as", h("strong", { text: name })),
    h("a", { href: "#/settings/apps", role: "menuitem", onclick: closeMenu }, icon("plug"), "Connected apps"),
    h("a", { href: "#/settings/api-keys", role: "menuitem", onclick: closeMenu }, icon("key"), "API keys"),
    h("a", { href: "#/settings/tokens", role: "menuitem", onclick: closeMenu }, icon("key"), "Agent tokens"),
    h("a", { href: "#/settings/device", role: "menuitem", onclick: closeMenu }, icon("phone"), "Offline on this device"),
    h("hr", { role: "separator" }),
    h("button", { type: "button", role: "menuitem", onclick: function () { closeMenu(); logout(); } }, icon("logout"), "Sign out"));
  var btn = h("button", { type: "button", class: "acct", "aria-label": "Account: " + name, "aria-haspopup": "menu", "aria-expanded": "false", title: "Account and settings",
    onclick: function (e) { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); } },
    h("span", { class: "avatar", "aria-hidden": "true", text: initials(name) }), h("span", { class: "acct-name", text: name }));
  function items() { return Array.prototype.slice.call(menu.querySelectorAll("a,button")); }
  function onDoc(e) { if (!menu.contains(e.target)) closeMenu(); }
  function onKey(e) {
    if (e.key === "Escape") { closeMenu(); btn.focus(); return; }
    if (e.key === "Tab") { closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); var xs = items(), i = xs.indexOf(document.activeElement);
      xs[(i + (e.key === "ArrowDown" ? 1 : xs.length - 1)) % xs.length].focus();
    }
  }
  function openMenu() { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); document.addEventListener("click", onDoc); document.addEventListener("keydown", onKey); var f = items()[0]; if (f) f.focus(); }
  function closeMenu() { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); }
  whoEl.append(btn, menu);
}
function shell(crumbs) {
  setCrumbs(crumbs || []); setWho(); setNav();
  app.replaceChildren();
  for (var i = 1; i < arguments.length; i++) add(app, arguments[i]);
  applyRouteFocus();
}
// Page header: optional eyebrow, title (h1), optional subtitle; actions on the right.
function pageHead(title, opts) {
  opts = opts || {};
  var h1 = typeof title === "string" ? h("h1", { text: title }) : title;
  return h("div", { class: "page-head" },
    h("div", { class: "ph-text" }, opts.eyebrow ? h("span", { class: "eyebrow", text: opts.eyebrow }) : null, h1, opts.sub ? h("p", { class: "ph-sub", text: opts.sub }) : null),
    opts.actions ? h("div", { class: "ph-actions" }, opts.actions) : null);
}
// Purposeful empty/error state with a supported next step.
function stateBox(kind, iconName, title, text, actions) {
  return h("div", { class: "state" + (kind === "error" ? " error" : ""), role: kind === "error" ? "alert" : null },
    h("span", { class: "st-icon", "aria-hidden": "true" }, icon(iconName)), h("h3", { text: title }), text ? h("p", { text: text }) : null,
    actions ? h("div", { class: "row" }, actions) : null);
}
// Loading placeholder rows that reserve layout space.
function skeletonRows(list, n) {
  list.setAttribute("aria-busy", "true");
  list.replaceChildren(h("li", { class: "sr", text: "Loading…" }));
  for (var i = 0; i < (n || 3); i++) list.append(h("li", { class: "skel", "aria-hidden": "true" }, h("div", { class: "grow" }, h("span", { class: "skel-line wide" }), h("span", { class: "skel-line" }))));
}
function doneLoading(list) { list.removeAttribute("aria-busy"); }
function rowLink(href, title) { return h("a", { class: "stretch", href: href, text: title }); }
function kindIcon(a) { return a.kind === "binary" ? (/^image\//.test(a.mime || "") ? "image" : "file") : a.kind === "csv" ? "table" : a.kind === "json" ? "braces" : "doc"; }
// Move focus to the new page content after in-app navigation, so keyboard and screen-reader users land on it.
// Decided when the route changes; applied after the new view has replaced main's content (shell), so a control
// that was inside the old view (tab, document row, Load more…) can't leave focus stranded on <body>.
// Not applied on first load (no navigation happened) or when focus is in the header/sidebar and still attached.
var routedOnce = false, focusAfterRender = false;
function focusMain() { focusAfterRender = routedOnce; routedOnce = true; }
function applyRouteFocus() {
  if (!focusAfterRender) return;
  var a = document.activeElement;
  // Something in the new view already took focus deliberately (e.g. sign-in field, conflict editor): keep it.
  if (a && a !== document.body && app.contains(a) && a !== app) { focusAfterRender = false; return; }
  // Focus left on a still-attached header/sidebar control (breadcrumb, nav link, account menu) moves to the content too,
  // so keyboard and screen-reader users land on the new page.
  focusAfterRender = false;
  try { app.focus({ preventScroll: true }); } catch (e) {}
}
var projectTitles = {};
function projCrumbs(pid, extra) {
  // The brand returns Home; project crumbs keep the existing project navigation.
  return [{ t: projectTitles[pid] || pid, href: "#/p/" + enc(pid) }].concat(extra || []);
}

function route() {
  runCleanups(false);
  var t = document.querySelector(".toast"); if (t) t.hidden = true;
  focusMain();
  var p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (S.offline) return offlineRoute();
  if (!S.me) { var n = S.note || ""; S.note = ""; return viewLogin(n); }
  if (p[0] === "settings" && p[1] === "publishing") return viewPublishingApps();
  if (p[0] === "settings" && p[1] === "device") return viewDevice();
  if (p[0] === "apps" || (p[0] === "settings" && p[1] === "apps")) return viewApps();
  if (p[0] === "settings" && p[1] === "tokens") return viewTokens();
  if (p[0] === "settings" && p[1] === "api-keys") return viewApiKeys();
  if (p[0] === "p" && p[1]) {
    if (p[2] === "a" && p[3]) return viewArtifact(p[1], p[3], p[4] === "edit" ? "edit" : "preview");
    if (p[2] === "trash") return viewList(p[1], true);
    if (p[2] === "grants") { location.replace("#/settings/tokens"); return; }
    return viewList(p[1], false);
  }
  if (p[0] === "projects") return viewProjects();
  return viewHome();
}

async function logout() {
  try { await api("POST", "/api/logout", {}, { noAuthRedirect: true }); } catch (e) {}
  clearAllDrafts();
  resumeClear();
  await OFF.clear();
  S.me = null; S.csrf = null;
  runCleanups(true);
  S.note = "Signed out. Local drafts and offline copies were removed from this device.";
  if (location.hash && location.hash !== "#/") location.hash = "#/"; else route();
}

// ---------- login ----------
function viewLogin(note) {
  var msg = h("p", { class: "msg", role: "status" });
  var pass = h("input", { type: "password", autocomplete: "current-password", placeholder: "Local dev passphrase", required: true, name: "passphrase" });
  var btn = h("button", { type: "submit" }, "Sign in");
  var form = h("form", { class: "card", onsubmit: async function (e) {
    e.preventDefault(); btn.disabled = true; showMsg(msg, "");
    try {
      var r = await api("POST", "/auth/dev-login", { passphrase: pass.value }, { noAuthRedirect: true });
      pass.value = "";
      S.csrf = r.csrf;
      var me = await api("GET", "/api/me", undefined, { noAuthRedirect: true });
      S.me = me.principal; S.csrf = me.csrf || S.csrf;
      purgeForeignDrafts(S.me.id);
      route();
    } catch (err) { showErr(msg, err); btn.disabled = false; }
  } }, h("h1", { text: "Sign in" }),
    h("p", { class: "muted small", text: "Local development login (loopback only)." }),
    h("div", { class: "row" }, pass, btn), msg);
  shell([{ t: "Sign in" }], note ? h("p", { class: "banner", text: note }) : null, form);
  pass.focus();
}

// ---------- home: authorized recents and browser-local personal favorites ----------
function favoriteButton(pid, aid, changed, title) {
  var uid = S.me && S.me.id;
  var b = h("button", { type: "button", class: "icon favorite", "aria-label": "Add to favorites", "aria-pressed": "false" });
  function draw() {
    var on = HOME.has(HOME.read(uid), pid, aid);
    b.textContent = on ? "★" : "☆"; b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", (on ? "Remove from favorites" : "Add to favorites") + (title ? ": " + title : ""));
    b.title = on ? "Remove from favorites" : "Add to favorites";
  }
  draw();
  b.addEventListener("click", function (e) {
    e.stopPropagation();
    if (!uid || !S.me || S.me.id !== uid) return;
    try { HOME.toggle(uid, pid, aid); draw(); if (changed) changed(); }
    catch (err) { toast("Favorites could not be saved in this browser. Check browser storage and try again."); }
  });
  return b;
}
async function viewHome() {
  var uid = S.me.id, alive = true, seq = 0, rows = [], visible = 50, failed = 0;
  var pref = HOME.read(uid), tab = pref.tab, mode = pref.sort;
  var msg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var list = h("ul", { class: "list home-list", "aria-label": "Home documents" }), empty = h("div", { hidden: true });
  // A filter over one list (not separate panels): a labelled group of toggle buttons with aria-pressed.
  var recent = h("button", { type: "button", "aria-pressed": "false" }, "Recently edited"), favorites = h("button", { type: "button", "aria-pressed": "false" }, "Favorites");
  var homeTabs = h("div", { class: "tabs", role: "group", "aria-label": "Show" }, recent, favorites);
  function markFilter() { recent.setAttribute("aria-pressed", String(tab !== "favorites")); favorites.setAttribute("aria-pressed", String(tab === "favorites")); }
  var more = h("button", { type: "button", class: "secondary", hidden: true }, "Show more");
  var refresh = h("button", { type: "button", class: "ghost" }, icon("refresh"), "Refresh");
  var sorting = h("select", { "aria-label": "Sort documents" }, [["newest", "Newest edit first"], ["oldest", "Oldest edit first"], ["title", "Title A–Z"]].map(function (x) { return h("option", { value: x[0], selected: mode === x[0], text: x[1] }); }));
  function current(my) { return alive && !!S.me && S.me.id === uid && my === seq; }
  function draw() {
    if (!alive || !S.me || S.me.id !== uid) return;
    markFilter();
    var fav = HOME.read(uid), selected = rows.filter(function (a) { return tab !== "favorites" || HOME.has(fav, a.pid, a.id); });
    selected = HOME.order(selected, mode); list.replaceChildren();
    selected.slice(0, visible).forEach(function (a) {
      var href = "#/p/" + enc(a.pid) + "/a/" + enc(a.id);
      var stamp = Number.isFinite(Date.parse(a.updated_at)) ? "Edited " + fmtDate(a.updated_at) : "Edit time unavailable";
      var details = h("span", { class: "meta", text: kindLabel(a) + " · " + a.project_title + " · " + stamp + " · rev " + a.revision });
      list.append(h("li", { class: "link", dataset: { projectId: a.pid, artifactId: a.id } },
        h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon(kindIcon(a))),
        h("div", { class: "grow" }, rowLink(href, a.title), details),
        h("span", { class: "badge", text: kindLabel(a) }), favoriteButton(a.pid, a.id, draw, a.title)));
    });
    list.hidden = !selected.length; empty.replaceChildren(); empty.hidden = !!selected.length;
    if (!selected.length) empty.append(failed ? stateBox("error", "alert", "Nothing could be loaded", "Some projects didn't respond. Nothing was changed. Try again.", h("button", { type: "button", class: "secondary", onclick: load }, icon("refresh"), "Try again"))
      : tab === "favorites" ? stateBox("", "home", "No favorites yet", "Star a document from its page or from Recently edited to keep it here. Favorites are saved on this device.")
      : stateBox("", "doc", "No documents yet", "Open a project to write your first document, or connect an app to publish into one.", h("a", { class: "btn", href: "#/projects" }, icon("folder"), "Open projects")));
    more.hidden = selected.length <= visible;
  }
  function remember() { try { HOME.prefs(uid, tab, mode); } catch (e) { showMsg(msg, "View preferences could not be saved in this browser."); } }
  async function load() {
    var my = ++seq; rows = []; failed = 0; visible = 50; list.hidden = false; empty.hidden = true; skeletonRows(list, 4); refresh.disabled = true; more.hidden = true;
    showMsg(msg, ""); markFilter();
    try {
      var result = await HOME.load(api, function () { return current(my); });
      if (!current(my)) return; rows = result.rows; failed = result.failed; doneLoading(list);
      result.projects.forEach(function (p) { projectTitles[p.id] = p.title; });
      draw(); if (failed) showMsg(msg, "Some projects could not be loaded. Showing only verified accessible documents. Refresh to retry.");
      resumeApply("home");
    } catch (e) {
      if (!current(my) || e.cancelled) return;
      doneLoading(list); list.hidden = true; empty.hidden = false;
      empty.replaceChildren(stateBox("error", "alert", "Home couldn't load", "Check your connection and try again. Your documents are unchanged.", h("button", { type: "button", class: "secondary", onclick: load }, icon("refresh"), "Try again")));
    } finally { if (current(my)) refresh.disabled = false; }
  }
  recent.addEventListener("click", function () { tab = "recent"; remember(); load(); });
  favorites.addEventListener("click", function () { tab = "favorites"; remember(); load(); });
  sorting.addEventListener("change", function () { mode = sorting.value; visible = 50; remember(); draw(); });
  more.addEventListener("click", function () { visible += 50; draw(); });
  refresh.addEventListener("click", load);
  function changed(e) { if (e.key === "al:home:" + encodeURIComponent(uid)) { pref = HOME.read(uid); tab = pref.tab; mode = pref.sort; sorting.value = mode; draw(); } }
  function foreground() { if (!document.hidden) load(); }
  window.addEventListener("storage", changed); document.addEventListener("visibilitychange", foreground);
  S.cleanups.push(function () { alive = false; ++seq; window.removeEventListener("storage", changed); document.removeEventListener("visibilitychange", foreground); });
  shell([{ t: "Home" }], pageHead("Home", { sub: "Recently edited documents across your projects. Favorites are saved for your account on this device.",
      actions: h("a", { class: "btn secondary", href: "#/projects" }, icon("folder"), "All projects") }),
    h("div", { class: "toolbar" }, homeTabs, h("span", { class: "spacer" }),
      h("label", { class: "row small muted" }, "Sort", sorting), refresh),
    msg, list, empty, more);
  await load();
}

// ---------- projects ----------
async function viewProjects() {
  var msg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var list = h("ul", { class: "list", "aria-label": "Projects" }), empty = h("div", { hidden: true });
  var title = h("input", { type: "text", placeholder: "Project name", required: true, maxLength: 200, "aria-label": "New project name" });
  var createBtn = h("button", { type: "submit" }, "Create project");
  var form = h("form", { class: "card row", hidden: true, "aria-label": "New project", onsubmit: async function (e) {
    e.preventDefault(); createBtn.disabled = true; showMsg(msg, "");
    // On failure the typed name stays in the field so the owner can retry.
    try { var r = await api("POST", "/api/projects", { title: title.value.trim() }); projectTitles[r.id] = r.title; location.hash = "#/p/" + enc(r.id); }
    catch (err) { showErr(msg, err); createBtn.disabled = false; }
  } }, title, createBtn, h("button", { type: "button", class: "secondary", onclick: function () { form.hidden = true; newBtn.hidden = false; newBtn.focus(); } }, "Cancel"));
  var newBtn = h("button", { type: "button", onclick: function () { form.hidden = false; newBtn.hidden = true; title.focus(); } }, icon("plus"), "New project");
  shell([{ t: "Home", href: "#/" }, { t: "Projects" }], pageHead("Projects", { sub: "Each project keeps its own documents, files and access. Apps only see the projects you share with them.", actions: newBtn }), form, msg, list, empty);
  skeletonRows(list, 3);
  async function load() {
    try {
      var r = await api("GET", "/api/projects");
      doneLoading(list); list.replaceChildren(); list.hidden = !r.projects.length; empty.hidden = !!r.projects.length;
      if (!r.projects.length) empty.replaceChildren(stateBox("", "folder", "No projects yet", "Create a project to start writing, or let a connected app create one when you approve it.", h("button", { type: "button", onclick: function () { newBtn.click(); } }, icon("plus"), "New project")));
      r.projects.forEach(function (p) {
        projectTitles[p.id] = p.title;
        var href = "#/p/" + enc(p.id);
        list.append(h("li", { class: "link" }, h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon("folder")),
          h("div", { class: "grow" }, rowLink(href, p.title)), h("span", { class: "chev", "aria-hidden": "true" }, icon("chevron"))));
      });
      resumeApply("projects");
    } catch (err) {
      doneLoading(list); list.hidden = true; empty.hidden = false;
      if (err.status === 401) return;
      empty.replaceChildren(stateBox("error", "alert", "Projects couldn't load", (err.status === 0 ? "You appear to be offline." : err.message + (err.status ? " (" + err.status + ")" : "")) + " Nothing was changed.",
        h("button", { type: "button", class: "secondary", onclick: function () { empty.hidden = true; list.hidden = false; skeletonRows(list, 3); load(); } }, icon("refresh"), "Try again")));
    }
  }
  load();
}

async function ensureProjectTitle(pid) {
  if (projectTitles[pid]) return;
  try { var r = await api("GET", "/api/projects"); r.projects.forEach(function (p) { projectTitles[p.id] = p.title; }); setCrumbsTitle(pid); } catch (e) {}
}
function setCrumbsTitle(pid) {
  var a = crumbsEl.querySelector("a[href='#/p/" + enc(pid) + "']");
  if (a && projectTitles[pid]) { a.textContent = projectTitles[pid]; a.title = projectTitles[pid]; }
  // Current-page crumb (project page) is text, not a link.
  var only = crumbsEl.children.length === 1 && crumbsEl.firstChild.getAttribute("aria-current") === "page" && crumbsEl.firstChild.textContent === pid ? crumbsEl.firstChild : null;
  if (only && projectTitles[pid]) { only.textContent = projectTitles[pid]; only.title = projectTitles[pid]; }
  var h1 = app.querySelector("h1[data-project-title]");
  if (h1 && h1.dataset.projectTitle === pid && projectTitles[pid] && h1.textContent !== "Trash") h1.textContent = projectTitles[pid];
}

function projectTabs(pid, active) {
  var tabs = [["list", "Documents", "#/p/" + enc(pid)], ["trash", "Trash", "#/p/" + enc(pid) + "/trash"]];
  return linkTabs("Project views", tabs, active);
}

// ---------- artifact list ----------
function guessMime(file) {
  var n = (file.name || "").toLowerCase();
  if (file.type === "image/png" || /\.png$/.test(n)) return "image/png";
  if (file.type === "image/jpeg" || /\.jpe?g$/.test(n)) return "image/jpeg";
  if (file.type === "image/webp" || /\.webp$/.test(n)) return "image/webp";
  if (file.type === "image/gif" || /\.gif$/.test(n)) return "image/gif";
  if (file.type === "application/pdf" || /\.pdf$/.test(n)) return "application/pdf";
  if (file.type === "video/mp4" || /\.mp4$/.test(n)) return "video/mp4";
  if (file.type === "video/webm" || /\.webm$/.test(n)) return "video/webm";
  return "application/octet-stream";
}

// begin -> PUT bytes -> finish. keys are reused across retries of the same file/target.
async function uploadFile(pid, file, target, keys, status) {
  status("Hashing " + file.name + "...");
  var buf = await file.arrayBuffer();
  var sha = hex(await crypto.subtle.digest("SHA-256", buf));
  var mime = guessMime(file);
  var fp = [file.name, file.size, file.lastModified, sha, target.artifact_id || "", target.expected_revision || "", target.title || ""].join("|");
  if (keys.fp !== fp) { keys.fp = fp; keys.begin = uuid(); keys.finish = uuid(); }
  var begin = target.artifact_id
    ? { artifact_id: target.artifact_id, expected_revision: target.expected_revision, mime: mime, size: buf.byteLength, sha256: sha }
    : { title: target.title || file.name, mime: mime, size: buf.byteLength, sha256: sha };
  status("Starting upload (" + fmtBytes(buf.byteLength) + ", sha256 " + sha.slice(0, 12) + "...)");
  var b = await api("POST", "/api/projects/" + enc(pid) + "/uploads", begin, { key: keys.begin });
  status("Sending bytes...");
  try {
    var put = await api("PUT", b.put_url, buf, { raw: true, headers: { "content-type": "application/octet-stream" } });
    if (!put.matches_declared) throw new Error("Server received bytes that do not match the declared size/hash");
  } catch (e) {
    // A retried begin can return an upload whose bytes already arrived; finish will verify.
    if (!(e && e.status === 409 && e.code === "upload_not_writable")) throw e;
  }
  status("Verifying and publishing...");
  var f = await api("POST", "/api/projects/" + enc(pid) + "/uploads/" + enc(b.upload_id) + "/finish", {}, { key: keys.finish });
  keys.fp = null;
  return f;
}

// CSV / JSON files are text artifacts: they are created and replaced through the artifacts API (validated by the
// server: RFC 4180 CSV / JSON, UTF-8, max 1 MiB), not through the binary upload path.
var BINARY_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.mp4,.webm,image/png,image/jpeg,image/webp,image/gif,application/pdf,video/mp4,video/webm";
var DATA_ACCEPT = { csv: ".csv,text/csv", json: ".json,application/json" };
var DATA_MAX_BYTES = 1048576;
function dataKindOf(file) {
  var n = (file.name || "").toLowerCase();
  if (/\.csv$/.test(n) || file.type === "text/csv") return "csv";
  if (/\.json$/.test(n) || file.type === "application/json") return "json";
  return null;
}
// UTF-8 text of a data file, exactly as stored except a leading byte order mark (spreadsheet apps add one to "CSV
// UTF-8" exports; it is an encoding marker, not content, and the server rejects it). Invalid UTF-8 is refused.
// Problems found in the browser before anything is sent: shown as-is, with no "retry" hint.
function localUploadError(text) { var e = new Error(text); e.local = true; return e; }
async function readDataText(file) {
  if (file.size > DATA_MAX_BYTES + 3) throw localUploadError(file.name + " is " + fmtBytes(file.size) + "; CSV and JSON files can be up to 1 MiB");
  var text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch (e) { throw localUploadError(file.name + " isn't UTF-8 text. Save it as UTF-8 (e.g. \u201CCSV UTF-8\u201D) and try again"); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (utf8Len(text) > DATA_MAX_BYTES) throw localUploadError(file.name + " is " + fmtBytes(utf8Len(text)) + "; CSV and JSON files can be up to 1 MiB");
  return text;
}
async function uploadDataFile(pid, file, kind, target, keys, status) {
  status("Reading " + file.name + "…");
  var text = await readDataText(file);
  // Same checks as the preview (and the server), so a bad file is explained before anything is sent.
  try { if (kind === "csv") csvParse(text); else JSON.parse(text); }
  catch (e) { throw localUploadError(file.name + ": " + (kind === "csv" ? e.message : jsonErrorText(e, text)) + ". Fix the file and upload it again"); }
  // The content travels as a JSON string; quote-heavy files grow when escaped and the API caps the whole request
  // body at 2,097,152 characters (UTF-16 length, like this check). 2,000,000 leaves room for the other fields.
  if (JSON.stringify(text).length > 2000000) throw localUploadError(file.name + " is too large to upload once encoded (lots of quotes or special characters). Split it or remove some rows");
  var base = "/api/projects/" + enc(pid) + "/artifacts";
  var sha = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  var fp = [file.name, file.size, file.lastModified, sha, kind, target.artifact_id || "", target.expected_revision || "", target.title || ""].join("|");
  if (keys.fp !== fp) { keys.fp = fp; keys.begin = uuid(); }
  status("Checking and saving…");
  var r = target.artifact_id
    ? await api("PUT", base + "/" + enc(target.artifact_id), { expected_revision: target.expected_revision, content: text }, { key: keys.begin })
    : await api("POST", base, { kind: kind, title: target.title || file.name, content: text }, { key: keys.begin });
  keys.fp = null;
  return { artifact_id: r.artifact_id || target.artifact_id, revision: r.revision, size: utf8Len(text) };
}
// CSV / JSON files (and their spreadsheet-safe download) need the server's App Connect feature
// (APP_CONNECT_ENABLED). The browser has no flag for it, so it asks the API: listing by kind is an App Connect
// query, 404 when the feature is off. Resolves true / false, or null when it couldn't tell (network, auth):
// callers then keep the default and the server still decides. "On" is installation-wide and cached once. A 404
// is cached only for that project, because a missing or inaccessible project is also a 404.
var dataFilesOn = false, dataFilesP = {};
function dataFilesEnabled(pid) {
  if (dataFilesOn) return Promise.resolve(true);
  if (!dataFilesP[pid]) dataFilesP[pid] = api("GET", "/api/projects/" + enc(pid) + "/artifacts?kind=csv", undefined, { noAuthRedirect: true })
    .then(function () { dataFilesOn = true; return true; }, function (e) { if (e.status === 404 || e.status === 400) return false; delete dataFilesP[pid]; return null; });
  return dataFilesP[pid];
}
// accept: "all" (new items: media, PDF, CSV, JSON), "binary" (replace a media/PDF file), "csv" or "json" (replace a data file).
function uploadForm(pid, target, onDone, accept) {
  accept = accept || "binary";
  var msg = h("p", { class: "msg", role: "status" });
  var file = h("input", { type: "file", "aria-label": "File to upload", accept: accept === "all" ? BINARY_ACCEPT + "," + DATA_ACCEPT.csv + "," + DATA_ACCEPT.json : accept === "binary" ? BINARY_ACCEPT : DATA_ACCEPT[accept] });
  var title = target ? null : h("input", { type: "text", placeholder: "Title (defaults to file name)", "aria-label": "Title", maxLength: 200 });
  var btn = h("button", { type: "submit" }, target ? "Upload new version" : "Upload");
  var keys = {}, dataOff = false;
  if (accept === "all") dataFilesEnabled(pid).then(function (on) { if (on === false) { dataOff = true; file.accept = BINARY_ACCEPT; } });
  var form = h("form", { class: "row", onsubmit: async function (e) {
    e.preventDefault();
    var f = file.files && file.files[0];
    if (!f) { showMsg(msg, "Choose a file first."); return; }
    btn.disabled = true;
    try {
      var t = target ? target() : { title: title.value.trim() || f.name };
      var dk = dataKindOf(f), status = function (s) { showMsg(msg, s, true); };
      if (accept === "binary" && dk) throw localUploadError("This is a " + dk.toUpperCase() + " file; upload it as a new item instead");
      if (dk && dataOff) throw localUploadError("CSV and JSON files aren't enabled on this installation (App Connect is off)");
      if ((accept === "csv" || accept === "json") && dk !== accept) throw localUploadError("Choose a " + accept.toUpperCase() + " file to replace this one");
      var r = dk ? await uploadDataFile(pid, f, dk, t, keys, status) : await uploadFile(pid, f, t, keys, status);
      showMsg(msg, "Uploaded revision " + r.revision + " (" + fmtBytes(r.size) + ").", true);
      file.value = ""; if (title) title.value = "";
      if (onDone) onDone(r);
    } catch (err) {
      if (err.code === "revision_conflict") {
        showMsg(msg, "This file changed since you opened it (now at rev " + (((err.data || {}).error || {}).current_revision || "?") + "). ", false, true);
        if (onDone) msg.append(h("button", { type: "button", class: "secondary", onclick: function () { showMsg(msg, ""); onDone(null); } }, "Reload"));
      }
      else if (err.local) showMsg(msg, err.message + ".", false, true);
      // The server refused this content (invalid, too deep, too large): retrying the same file can't help.
      else if (err.status === 413 || err.status === 422) { if (err.code === "idempotency_key_reused") keys.fp = null; showErr(msg, err); }
      else {
        if (err.code === "idempotency_key_reused") keys.fp = null; // a different file under a reused key: next try gets a new key
        showErr(msg, err); msg.append(h("span", { text: " - press Upload again to retry." }));
      }
    }
    btn.disabled = false;
  } }, file, title, btn);
  return h("div", null, form, msg);
}

function kindLabel(a) { return a.kind === "markdown" ? "Doc" : a.kind === "html" ? "Page" : a.kind === "csv" ? "CSV" : a.kind === "json" ? "JSON" : "File"; }
function isTextDoc(kind) { return kind === "markdown" || kind === "html"; }
function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function viewList(pid, trash) {
  var msg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var list = h("ul", { class: "list", "aria-label": trash ? "Trashed items" : "Documents and files" }), empty = h("div", { hidden: true });
  var more = h("button", { type: "button", class: "secondary", hidden: true }, "Load more");
  var q = h("input", { type: "search", placeholder: trash ? "Search trash" : "Search titles and text", "aria-label": trash ? "Search trash" : "Search this project" });
  var cursor = null, seq = 0, qTimer = null;

  function row(a) {
    var info = h("span", { class: "meta", text: (a.is_template ? "Template" : kindLabel(a)) + " · Updated " + fmtDate(a.updated_at) + " · rev " + a.revision + (a.folder ? " · " + a.folder : "") + (a.tags && a.tags.length ? " · #" + a.tags.join(" #") : "") });
    var href = "#/p/" + enc(pid) + "/a/" + enc(a.id);
    var main = h("div", { class: "grow" }, trash ? h("span", { text: a.title }) : rowLink(href, a.title), info);
    var li = h("li", trash ? null : { class: "link" }, h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon(kindIcon(a))), main, h("span", { class: "badge", text: a.is_template ? "Template" : kindLabel(a) }));
    if (trash) li.append(h("button", { type: "button", class: "secondary", onclick: async function (e) {
      e.target.disabled = true;
      try { await api("PATCH", "/api/projects/" + enc(pid) + "/artifacts/" + enc(a.id), { expected_meta_version: a.meta_version, trashed: false }, { key: uuid() }); li.remove(); showMsg(msg, "Restored \"" + a.title + "\".", true); }
      catch (err) { showErr(msg, err); e.target.disabled = false; if (err.status === 409) load(true); }
    } }, "Restore"));
    return li;
  }
  function emptyFor(term) {
    if (term) return stateBox("", "search", "No matches for \u201C" + term + "\u201D", trash ? "Nothing in trash matches. Try a different word." : "Search looks at titles and document text in this project. Try a different word or clear the search.",
      h("button", { type: "button", class: "secondary", onclick: function () { q.value = ""; load(true); q.focus(); } }, "Clear search"));
    if (trash) return stateBox("", "trash", "Trash is empty", "Items you move to trash stay here with their history until you restore them.");
    return stateBox("", "doc", "This project is empty", "Write a document or upload an image, video or PDF. Connected apps you allow can also add items here.",
      [h("button", { type: "button", onclick: function () { newDocBtn.click(); } }, icon("plus"), "New document"), h("button", { type: "button", class: "secondary", onclick: function () { uploadBtn.click(); } }, icon("upload"), "Upload file")]);
  }
  async function load(reset) {
    var my = ++seq;
    if (reset) { cursor = null; list.hidden = false; empty.hidden = true; if (!list.children.length) skeletonRows(list, 3); else list.setAttribute("aria-busy", "true"); }
    var term = q.value.trim();
    var qs = "?q=" + enc(term) + (cursor ? "&cursor=" + enc(cursor) : "") + (trash ? "&trashed=1" : "");
    try {
      var r = await api("GET", "/api/projects/" + enc(pid) + "/artifacts" + qs);
      if (my !== seq) return;
      doneLoading(list);
      if (reset) list.replaceChildren();
      r.artifacts.forEach(function (a) { list.append(row(a)); });
      if (reset && !r.artifacts.length) { list.hidden = true; empty.hidden = false; empty.replaceChildren(emptyFor(term)); }
      cursor = r.next_cursor; more.hidden = !cursor;
      if (reset) resumeApply("list");
    } catch (err) {
      if (my !== seq) return;
      doneLoading(list);
      if (reset && err.status !== 401) {
        list.hidden = true; empty.hidden = false;
        empty.replaceChildren(err.status === 404 || err.status === 403
          ? stateBox("error", "alert", "Project not available", "It may have been removed, or this account can't open it.", h("a", { class: "btn secondary", href: "#/projects" }, "All projects"))
          : stateBox("error", "alert", "Couldn't load this project", (err.status === 0 ? "You appear to be offline." : err.message) + " Nothing was changed.", h("button", { type: "button", class: "secondary", onclick: function () { load(true); } }, icon("refresh"), "Try again")));
      } else showErr(msg, err);
    }
  }
  q.addEventListener("input", function () { clearTimeout(qTimer); qTimer = setTimeout(function () { load(true); }, 300); });
  more.addEventListener("click", function () { load(false); });
  S.cleanups.push(function () { clearTimeout(qTimer); });

  var actions = null, panel = null, newDocBtn = null, uploadBtn = null;
  if (!trash) {
    var dtitle = h("input", { type: "text", placeholder: "Document title", required: true, maxLength: 200, "aria-label": "New document title" });
    var dkind = h("select", { "aria-label": "Document type" }, h("option", { value: "markdown", text: "Markdown" }), h("option", { value: "html", text: "HTML page" }));
    var cmsg = h("p", { class: "msg", role: "status" });
    var start = h("select", { "aria-label": "Start from" }, h("option", { value: "", text: "Blank document" }));
    var startLabel = h("label", { hidden: true }, "Start from", start);
    var localNow = new Date();
    var date = h("input", { type: "date", "aria-label": "Template date", value: localNow.getFullYear() + "-" + String(localNow.getMonth() + 1).padStart(2, "0") + "-" + String(localNow.getDate()).padStart(2, "0") });
    var dateLabel = h("label", { hidden: true }, "Date", date);
    var templateHelp = h("p", { class: "muted small", role: "status", text: "Loading templates…" });
    var templatePreview = h("div", { class: "template-preview prose", hidden: true, tabIndex: 0, "aria-label": "Template preview" });
    var templateInfo = h("p", { class: "muted small", hidden: true });
    var templateRetry = h("button", { type: "button", class: "secondary", hidden: true, onclick: loadTemplates }, "Reload templates");
    var templates = {}, selectedTemplate = null, previewSeq = 0, previewTimer, previewReady = false, creating = false;
    var pending = null;
    var createBtn = h("button", { type: "submit" }, "Create");
    async function loadTemplates() {
      templateHelp.textContent = "Loading templates…"; templateRetry.hidden = true;
      try {
        var cursor = null, items = [];
        do {
          var page = await api("GET", "/api/projects/" + enc(pid) + "/templates" + (cursor ? "?cursor=" + enc(cursor) : ""));
          items = items.concat(page.templates); cursor = page.next_cursor;
        } while (cursor);
        templates = {};
        start.replaceChildren(h("option", { value: "", text: "Blank document" }));
        items.forEach(function (t) { templates[t.id] = t; start.append(h("option", { value: t.id, text: t.name + (t.description ? " — " + t.description : "") })); });
        if (selectedTemplate) {
          if (!templates[selectedTemplate.id]) { start.append(h("option", { value: selectedTemplate.id, text: selectedTemplate.name + " (unavailable)" })); }
          start.value = selectedTemplate.id; // Never silently replace its pinned revision.
        }
        startLabel.hidden = items.length === 0;
        templateHelp.textContent = items.length ? "Templates create independent Markdown documents." : "No templates yet. Open a Markdown document and choose Save as template.";
      } catch (err) { templateHelp.textContent = "Couldn't load templates: " + err.message + ". Blank document is still available."; templateRetry.hidden = false; }
    }
    function previewInput() { return { template_id: selectedTemplate.id, template_revision: selectedTemplate.revision, title: dtitle.value.trim(), date: date.value }; }
    function scheduleTemplatePreview() {
      clearTimeout(previewTimer); previewReady = false;
      var seq = ++previewSeq;
      dateLabel.hidden = !selectedTemplate; templateInfo.hidden = !selectedTemplate; templatePreview.hidden = !selectedTemplate;
      dkind.disabled = !!selectedTemplate; createBtn.textContent = selectedTemplate ? "Use template" : "Create";
      createBtn.disabled = creating || !!selectedTemplate;
      if (!selectedTemplate) { templatePreview.replaceChildren(); return; }
      templateInfo.textContent = selectedTemplate.name + " · v" + selectedTemplate.revision + (selectedTemplate.description ? " · " + selectedTemplate.description : "");
      templatePreview.textContent = "Loading preview…";
      previewTimer = setTimeout(async function () {
        try {
          var r = await api("POST", "/api/projects/" + enc(pid) + "/templates/preview", previewInput());
          if (seq !== previewSeq) return;
          templatePreview.innerHTML = r.html;
          templatePreview.append(h("p", { class: "muted small", text: "Placeholders: " + (r.placeholders.join(", ") || "none") + ". Unknown placeholders stay literal." + (r.truncated ? " Preview shortened; creation uses the full revision." : "") }));
          previewReady = true; createBtn.disabled = creating;
        } catch (err) { if (seq !== previewSeq) return; templatePreview.textContent = "Preview unavailable: " + err.message; }
      }, 160);
    }
    start.addEventListener("change", function () { selectedTemplate = templates[start.value] || null; scheduleTemplatePreview(); });
    dtitle.addEventListener("input", scheduleTemplatePreview); date.addEventListener("input", scheduleTemplatePreview);
    S.cleanups.push(function () { clearTimeout(previewTimer); previewSeq++; });
    var newDoc = h("div", { class: "card", hidden: true },
      h("form", { class: "template-form", onsubmit: async function (e) {
        e.preventDefault(); if (creating || (selectedTemplate && !previewReady)) return;
        var t = dtitle.value.trim(); if (!t) return;
        var kind = dkind.value === "html" ? "html" : "markdown";
        var req = selectedTemplate ? previewInput() : { title: t, body: kind === "html" ? "<h1>" + escHtml(t) + "</h1>\n<p></p>\n" : "# " + t + "\n\n", kind: kind };
        var path = "/api/projects/" + enc(pid) + "/artifacts" + (selectedTemplate ? "/from-template" : "");
        var signature = JSON.stringify([path, req]);
        if (!pending || pending.signature !== signature) pending = { signature: signature, key: uuid() };
        creating = true; createBtn.disabled = true;
        try { var r = await api("POST", path, req, { key: pending.key }); pending = null; location.hash = "#/p/" + enc(pid) + "/a/" + enc(r.artifact_id) + "/edit"; }
        catch (err) { showErr(cmsg, err); }
        finally { creating = false; createBtn.disabled = !!selectedTemplate && !previewReady; }
      } }, h("div", { class: "row" }, h("label", null, "Title", dtitle), h("label", null, "Document type", dkind)),
        startLabel, templateHelp, templateRetry, dateLabel, templateInfo, templatePreview,
        h("div", { class: "row" }, createBtn, h("button", { type: "button", class: "secondary", onclick: function () { newDoc.hidden = true; newDocBtn.setAttribute("aria-expanded", "false"); } }, "Cancel"))), cmsg);
    loadTemplates();
    var upHelp = h("p", { class: "muted small", text: "Images (PNG, JPEG, WebP, GIF), videos (MP4, WebM) or PDF, up to 5 MB. CSV or JSON data files (UTF-8), up to 1 MB." });
    dataFilesEnabled(pid).then(function (on) { if (on === false) upHelp.textContent = "Images (PNG, JPEG, WebP, GIF), videos (MP4, WebM) or PDF, up to 5 MB."; });
    var upload = h("div", { class: "card", hidden: true }, upHelp, uploadForm(pid, null, function () { load(true); }, "all"));
    var keepBtn = h("button", { type: "button", class: "ghost", title: "Save every document and file in this project on this device, and keep them up to date" }, icon("offline"), "Keep offline");
    OFF.get("projects", pid).then(function (p) { if (p) { keepBtn.classList.add("on"); keepBtn.lastChild.textContent = "Kept offline"; } }).catch(function () {});
    keepBtn.addEventListener("click", async function () {
      keepBtn.disabled = true;
      try {
        if (keepBtn.classList.contains("on")) {
          if (confirm("Stop keeping this project offline? Saved copies stay on this device until removed or expired (Settings → Offline).")) {
            await OFF.del("projects", pid); keepBtn.classList.remove("on"); keepBtn.lastChild.textContent = "Keep offline"; showMsg(msg, "No longer kept offline.", true);
          }
        } else {
          showMsg(msg, "Saving this project for offline use…", true);
          await OFF.put("projects", { pid: pid, title: projectTitles[pid] || pid, added_at: Date.now(), last_used: Date.now() });
          if (S.me) await OFF.put("meta", { k: "owner", id: S.me.id });
          keepBtn.classList.add("on"); keepBtn.lastChild.textContent = "Kept offline";
          var st = await offSyncProject(pid);
          showMsg(msg, st.capped ? "Offline storage limit reached (" + fmtBytes(offCapBytes()) + "): some items were not saved. Raise it in Settings → Offline."
            : "Saved " + (st.added + st.updated) + " item" + (st.added + st.updated === 1 ? "" : "s") + " for offline use" + (st.failed ? " (" + st.failed + " failed)" : "") + ". New items are added each time the app opens online.", !st.capped && !st.failed);
        }
      } catch (e) { showErr(msg, e); }
      keepBtn.disabled = false;
    });
    newDocBtn = h("button", { type: "button", "aria-expanded": "false", onclick: function () { upload.hidden = true; uploadBtn.setAttribute("aria-expanded", "false"); newDoc.hidden = !newDoc.hidden; newDocBtn.setAttribute("aria-expanded", String(!newDoc.hidden)); if (!newDoc.hidden) dtitle.focus(); } }, icon("plus"), "New document");
    uploadBtn = h("button", { type: "button", class: "secondary", "aria-expanded": "false", onclick: function () { newDoc.hidden = true; newDocBtn.setAttribute("aria-expanded", "false"); upload.hidden = !upload.hidden; uploadBtn.setAttribute("aria-expanded", String(!upload.hidden)); } }, icon("upload"), "Upload file");
    actions = [newDocBtn, uploadBtn, keepBtn];
    panel = [newDoc, upload];
  }
  var titleH1 = h("h1", { text: trash ? "Trash" : (projectTitles[pid] || "Documents"), dataset: { projectTitle: pid } });
  shell(projCrumbs(pid, trash ? [{ t: "Trash" }] : []),
    pageHead(titleH1, { eyebrow: trash ? (projectTitles[pid] || "Project") : "Project", actions: actions }),
    panel, h("div", { class: "toolbar" }, projectTabs(pid, trash ? "trash" : "list"), h("label", { class: "search" }, icon("search"), q)), msg, list, empty, more);
  ensureProjectTitle(pid);
  if (resumePending && resumePending.hash === location.hash && resumePending.q) q.value = resumePending.q;
  load(true);
  if (!trash) offTouch(pid, null);
}

// ---------- settings: connected apps (OAuth connections, all projects) ----------
// Connections (who can use your library) and Settings (this device) are separate primary sections.
var CONN_TABS = [["apps", "Reader apps"], ["publishing", "Publishing apps"], ["api-keys", "API keys"], ["tokens", "Agent tokens"]];
function settingsTabs(active) {
  var conn = active !== "device";
  var tabs = conn ? CONN_TABS : [["device", "Offline on this device"]];
  return linkTabs(conn ? "Connection types" : "Settings sections", tabs.map(function (t) { return [t[0], t[1], "#/settings/" + t[0]]; }), active);
}
function connHead(sub) {
  return pageHead("Connections", { sub: sub || "Apps and keys that can use your library. Signing in to an app never grants access by itself: an app can only use the projects you approved, and you can revoke it at any time." });
}
function connCard(o) {
  // o: { name, sub, status, access:[{title, access}], foot:[text], actions:[el], inactive }
  return h("article", { class: "conn" + (o.inactive ? " inactive" : ""), "aria-label": o.name },
    h("div", { class: "conn-head" }, h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon(o.icon || "plug")),
      h("div", { class: "grow" }, h("h3", { text: o.name }), o.sub ? h("p", { class: "conn-sub", text: o.sub }) : null), o.status,
      o.actions && o.actions.length ? h("div", { class: "row" }, o.actions) : null),
    o.accessLabel ? h("div", { class: "small muted", text: o.accessLabel }) : null,
    o.access ? (o.access.length ? h("ul", { class: "conn-access", "aria-label": "Saved project access" }, o.access.map(function (p) { return h("li", null, h("b", { text: p.title }), h("span", { text: p.access })); }))
      : h("p", { class: "small muted", text: "No projects. This connection can't open anything." })) : null,
    o.foot && o.foot.length ? h("div", { class: "conn-foot" }, o.foot.map(function (t) { return h("span", { text: t }); })) : null);
}
function statusLabel(st) {
  return st === "registered" ? "Registered" : st === "active" ? "Active" : st === "revoked" ? "Revoked" : st === "expired" ? "Expired" : st === "disabled" ? "Disabled" : st;
}
function accessText(a) { return a === "read+write" ? "read & edit" : "read"; }
function statusBadge(st) { return h("span", { class: "badge" + (st === "active" ? " active" : st === "expired" ? " warnb" : ""), text: statusLabel(st) }); }
async function viewApps() {
  var msg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var conns = h("div", { "aria-busy": "true" }, h("p", { class: "muted", text: "Loading connections…" }));
  var showAll = h("input", { type: "checkbox" });
  var data = null;
  function draw() {
    conns.removeAttribute("aria-busy"); conns.replaceChildren();
    var cs = data.connections.filter(function (c) { return showAll.checked || c.status === "active"; });
    if (!cs.length) conns.append(stateBox("", "plug", showAll.checked ? "No reader apps yet" : "No active reader apps",
      "Add Agent Library as a connector in ChatGPT, Claude or another app. You'll sign in, then choose exactly which projects it may read or edit."));
    cs.forEach(function (c) {
      // Actual saved access from the server; nothing here is assumed from sign-in.
      var btn = c.status === "active" ? h("button", { type: "button", class: "danger", onclick: async function (e) {
        if (!confirm("Disconnect " + c.client_name + "? It loses access to " + c.projects.length + " project(s) immediately.")) return;
        e.target.disabled = true;
        try { await api("POST", "/api/connections/" + enc(c.id) + "/revoke", {}); toast("Disconnected " + c.client_name); load(); }
        catch (err) { showErr(msg, err); e.target.disabled = false; }
      } }, "Disconnect") : null;
      conns.append(connCard({ name: c.client_name, sub: "Reader app · returns to " + c.redirect_host, status: statusBadge(c.status), inactive: c.status !== "active",
        accessLabel: c.status === "active" ? "Can currently use:" : "Had access to (no longer active):",
        access: c.projects.map(function (p) { return { title: p.title, access: accessText(p.access) }; }),
        foot: [c.files === false && c.status === "active" ? "Documents only: reconnect to include files" : null, c.last_used_at ? "Last used " + fmtDate(c.last_used_at) : "Not used yet", "Connected " + fmtDate(c.created_at), c.status === "active" ? "Expires " + fmtDate(c.expires_at) : null].filter(Boolean),
        actions: btn ? [btn] : [] }));
    });
  }
  async function load() {
    try { data = await api("GET", "/api/access"); draw(); }
    catch (err) { conns.removeAttribute("aria-busy"); if (err.status === 401) return; conns.replaceChildren(stateBox("error", "alert", "Connections couldn't load", (err.status === 0 ? "You appear to be offline." : err.message) + " No access was changed.", h("button", { type: "button", class: "secondary", onclick: load }, icon("refresh"), "Try again"))); }
  }
  showAll.addEventListener("change", function () { if (data) draw(); });
  shell([{ t: "Connections" }], connHead(), settingsTabs("apps"),
    h("div", { class: "callout" }, icon("plug"), h("span", null, h("strong", { text: "Reader apps" }), " read (and, if you allowed it, edit) documents and files in the projects listed on each card. Apps connected before files were available see documents only until you reconnect them. Disconnecting takes effect immediately and doesn't affect other apps.")),
    msg, conns, h("p", null, h("label", { class: "muted small" }, showAll, "Show disconnected and expired")));
  load();
}

// Registration only; destination selection remains in later consent.
function viewPublishingApps() {
  if (S.offline) return shell([{t:"Settings"}],h("h1",{text:"Publishing apps"}),h("p",{text:"Publishing app registration is unavailable offline. Reconnect and sign in as the owner."}),h("a",{href:"#/settings/device"},"Offline settings"));
  if (!S.me || S.me.kind !== "human") return viewLogin("Only the authorized owner can register publishing apps.");
  var uid=S.me.id, key="al:app-registration:"+uid, alive=true, busy=false, allowed=false;
  var msg=h("p",{class:"msg",role:"status","aria-live":"polite"}), list=h("div");
  var name=h("input",{required:true,maxLength:80,"aria-label":"App name"});
  var origins=h("textarea",{rows:3,"aria-label":"Allowed origins",placeholder:"https://example.com"});
  var callbacks=h("textarea",{rows:3,required:true,"aria-label":"Callback URLs",placeholder:"https://example.com/callback"});
  var sugProject=h("input",{maxLength:80,"aria-label":"Suggested project",placeholder:"Project name or ID"}),sugFolder=h("input",{maxLength:80,"aria-label":"Suggested folder",placeholder:"Folder name"});
  [name,origins,callbacks,sugProject,sugFolder].forEach(function(e){e.classList.add("full-w");});
  var submit=h("button",{type:"submit",disabled:true},"Register app");
  var prefill=h("button",{type:"button",class:"secondary",onclick:function(){name.value="Example app";origins.value="https://app.example.com";callbacks.value="https://app.example.com/agent-library/callback";}},"Use example values");
  var form=h("form",{class:"card publishing-registration",hidden:true,onsubmit:function(e){e.preventDefault();register();}},
    h("h2",{text:"Register a publishing app"}),
    h("p",{text:"Registration creates a public app ID. It does not connect a project or export data. Choose the authorized project and optional folder later when connecting from the app."}),
    h("label",null,"App name",name),h("label",null,"Allowed origins (one per line, up to 3; optional)",origins),
    h("label",null,"Exact callback URLs (one per line, 1–3)",callbacks),
    h("label",null,"Suggested project (optional)",sugProject),h("label",null,"Suggested folder (optional)",sugFolder),
    h("p",{class:"muted small",text:"Pre-filled on the consent page when the app connects; you can always change them there. The app can also suggest its own with agentlib_project and agentlib_folder."}),
    h("p",{class:"muted small",text:"Use HTTPS, or HTTP localhost/127.0.0.1 for local development. Origins have no path. Callbacks have a path, without queries, fragments or wildcards. Values are registered exactly as shown."}),
    h("div",{class:"row"},submit,prefill,h("button",{type:"button",class:"secondary",onclick:function(){location.hash="#/settings/apps";}},"Cancel")));
  function current(){return alive&&S.me&&S.me.id===uid&&S.me.kind==="human";}
  function pending(){return JSON.parse(localStorage.getItem(key)||"null");}
  function setBusy(v){busy=v;[submit,prefill,name,origins,callbacks,sugProject,sugFolder].forEach(function(e){e.disabled=v||!allowed;});}
  function same(c,v){function sorted(a){return JSON.stringify((a||[]).slice().sort());}return c.display_name===v.display_name&&sorted(c.origins)===sorted(v.origins)&&sorted(c.redirect_uris)===sorted(v.redirect_uris);}
  function draw(cs){list.replaceChildren(h("h2",{text:"Registered publishing apps"}));if(!cs.length)list.append(stateBox("","upload","No publishing apps registered","Register an app below. Registering does not connect a project or export anything."));cs.forEach(function(c){
    var id=h("input",{readOnly:true,value:c.client_id,"aria-label":c.display_name+" public client ID",class:"token"});
    // Publishing access is shown from saved publisher records only; registration alone grants nothing.
    var pubs=(c.publishers||[]),active=pubs.filter(function(p){return p.status==="active";});
    list.append(connCard({name:c.display_name,icon:"upload",sub:"Publishing app · "+((c.origins||[]).join(", ")||"no web origins"),
      status:statusBadge(c.disabled?"disabled":active.length?"active":"registered"),inactive:!!c.disabled,
      accessLabel:active.length?"Publishes into:":"Not connected to any project yet. Connect from the app and choose a destination; you approve it on a consent page.",
      access:active.length?active.map(function(p){return {title:projectTitles[p.project_id]||p.project_id,access:(p.folder_id?"own folder":"project root")+(p.current_source_revision!=null?" · export rev "+p.current_source_revision:" · no exports yet")};}):undefined,
      foot:["Callbacks: "+(c.redirect_uris||[]).join(", ")].concat(c.suggested_project||c.suggested_folder?["Suggests: "+(c.suggested_project||"first project")+" / "+(c.suggested_folder||"app name")]:[]).concat(["Registered "+fmtDate(c.created_at)])}),
      h("details",null,h("summary",{text:"Public client ID (not a secret)"}),h("div",{class:"row"},id,h("button",{type:"button",class:"secondary",onclick:function(){id.select();copyText(c.client_id,msg);}},icon("copy"),"Copy"))));
  });}
  async function load(){try{var cs=(await api("GET","/api/app-clients")).app_clients;if(!current())return;draw(cs);form.hidden=false;allowed=cs.length<100;if(!allowed)showMsg(msg,"The registration list is full. Ask for help before adding another app.");var p=pending();if(p){name.value=p.display_name;origins.value=p.origins.join("\n");callbacks.value=p.redirect_uris.join("\n");sugProject.value=p.suggested_project||"";sugFolder.value=p.suggested_folder||"";var matches=cs.filter(function(c){return same(c,p);});if(matches.length===1&&!matches[0].disabled){localStorage.removeItem(key);showMsg(msg,"Registration confirmed. Use the public client ID below.");}else{allowed=false;showMsg(msg,"A previous registration is unresolved. Nothing will be submitted again. Refresh to check its result; if it stays unresolved, ask for help before registering again.");}}setBusy(false);}catch(err){if(!current())return;allowed=false;form.hidden=true;showMsg(msg,err.status===404?"Publishing app registration is unavailable.":err.status===403?"Only the authorized owner can register publishing apps.":"Could not safely check registrations. Refresh to try again.");}}
  function values(){function lines(value,min,re,label){var xs=value.split(/\r?\n/).map(function(x){return x.trim();}).filter(Boolean);if(xs.length<min||xs.length>3||new Set(xs).size!==xs.length)throw Error(label+": use "+min+"–3 distinct values, one per line.");xs.forEach(function(x){if(x.length>300||!re.test(x))throw Error(label+": enter an exact HTTPS URL or supported local development URL.");var u=new URL(x);if((label==="Origins"?u.origin:u.href)!==x||u.hostname.indexOf("..")>=0||u.hostname.charAt(0)==="."||u.hostname.endsWith("."))throw Error(label+": use the canonical exact URL without normalization.");if(u.port&&(+u.port<1||+u.port>65535))throw Error(label+": invalid port.");});return xs;}var n=name.value.trim();if(!n||n.length>80)throw Error("App name must contain 1–80 characters.");return {display_name:n,origins:lines(origins.value,0,/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?$/,"Origins"),redirect_uris:lines(callbacks.value,1,/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?\/[A-Za-z0-9/_.~-]*$/,"Callbacks"),suggested_project:sugg(sugProject.value,"Suggested project"),suggested_folder:sugg(sugFolder.value,"Suggested folder")};}
  function sugg(v,label){v=v.trim();if(!v)return null;if(v.length>80||/[\/\u0000-\u001f\u007f]/.test(v))throw Error(label+": 1–80 characters, without /.");return v;}
  async function register(){if(!current()||busy||!allowed)return;var v,sent=false;try{v=values();}catch(err){showMsg(msg,err.message);return;}setBusy(true);
    async function create(){if(!current())return;if(pending()){allowed=false;await load();return;}var cs=(await api("GET","/api/app-clients")).app_clients;if(!current())return;
      if(cs.length>=100){allowed=false;showMsg(msg,"The registration list is full. Ask for help before adding another app.");return;}
      var related=cs.filter(function(c){return c.display_name===v.display_name||(c.origins||[]).some(function(o){return v.origins.indexOf(o)>=0;});});
      if(related.length){draw(cs);showMsg(msg,related.length===1&&same(related[0],v)&&!related[0].disabled?"Already registered with these exact values. Use the public client ID below.":"An existing registration overlaps this name or origin. Review it below before creating another app; nothing was changed.");return;}
      // Persist only public metadata before the one POST; ambiguous outcomes cannot silently retry.
      localStorage.setItem(key,JSON.stringify(v));allowed=false;sent=true;var result=await api("POST","/api/app-clients",v);if(!result||!result.client_id||!same(result,v))throw Error("Unconfirmed response");if(localStorage.getItem(key)===JSON.stringify(v))localStorage.removeItem(key);if(!current())return;allowed=true;showMsg(msg,"App registered. Copy its public client ID below, then connect from the app to choose a destination.");await load();
    }
    try{if(navigator.locks)await navigator.locks.request(key,create);else await create();}catch(err){var rejected=sent&&[400,401,403,404,413,422,429].indexOf(err.status)>=0;if(rejected&&localStorage.getItem(key)===JSON.stringify(v))localStorage.removeItem(key);if(current()){allowed=rejected;showMsg(msg,rejected?"Registration was rejected ("+err.status+"). Review the details or sign in again before trying again.":"Registration could not be confirmed. Refresh to check its result. Nothing will be submitted again automatically.");}}finally{if(current())setBusy(false);}
  }
  S.cleanups.push(function(){alive=false;});
  shell([{t:"Connections"}],connHead(),settingsTabs("publishing"),h("div",{class:"callout"},icon("upload"),h("span",null,h("strong",{text:"Publishing apps"})," send their own files into the one project and folder you choose when you connect them. They can't read anything else. Reader apps and keys are approved separately.")),msg,list,form);api("GET","/api/projects").then(function(r){r.projects.forEach(function(p){projectTitles[p.id]=p.title;});}).catch(function(){}).then(load);
}

// ---------- settings: agent tokens (advanced: scripts and local agents) + backup ----------
async function viewTokens() {
  var msg = h("p", { class: "msg", role: "status" });
  var list = h("ul", { class: "list" });
  var showAll = h("input", { type: "checkbox" });
  var data = null, projects = [];
  var proj = h("select", { "aria-label": "Project" });
  var label = h("input", { type: "text", placeholder: "Label, e.g. backup script", required: true, maxLength: 80, "aria-label": "Token label" });
  var canWrite = h("input", { type: "checkbox" });
  var ttl = h("input", { type: "number", min: 1, max: 720, value: 24, "aria-label": "Expires after (hours)" });
  ttl.size = 4;
  var tokenBox = h("div", { class: "card", hidden: true });
  function draw() {
    list.replaceChildren();
    var gs = data.grants.filter(function (g) { return showAll.checked || g.status === "active"; });
    if (!gs.length) list.append(h("li", { class: "empty", text: showAll.checked ? "No agent tokens." : "No active agent tokens. That's normal: most apps connect by signing in." }));
    gs.forEach(function (g) {
      var li = h("li", null,
        h("div", { class: "grow" }, h("strong", { text: g.label }), h("small", { text: g.project_title + " (" + accessText(g.access) + ")" }),
          h("small", { class: "muted", text: "Created " + fmtDate(g.created_at) + (g.status === "active" ? " · expires " + fmtDate(g.expires_at) : "") })),
        statusBadge(g.status));
      if (g.status === "active") li.append(h("button", { type: "button", class: "danger", onclick: async function (e) {
        if (!confirm("Revoke \"" + g.label + "\"? Anything using it loses access immediately.")) return;
        e.target.disabled = true;
        try { await api("PATCH", "/api/projects/" + enc(g.project_id) + "/grants/" + enc(g.id), { revoke: true }); toast("Revoked " + g.label); load(); }
        catch (err) { showErr(msg, err); e.target.disabled = false; }
      } }, "Revoke"));
      list.append(li);
    });
  }
  async function load() {
    try {
      var r = await Promise.all([api("GET", "/api/access"), api("GET", "/api/projects")]);
      data = r[0]; projects = r[1].projects;
      if (!proj.options.length) projects.forEach(function (p) { projectTitles[p.id] = p.title; proj.append(h("option", { value: p.id, text: p.title })); });
      draw();
    } catch (err) { showErr(msg, err); }
  }
  showAll.addEventListener("change", function () { if (data) draw(); });
  var form = h("form", { onsubmit: async function (e) {
    e.preventDefault();
    try {
      var r = await api("POST", "/api/projects/" + enc(proj.value) + "/grants", { label: label.value.trim(), can_write: canWrite.checked, ttl_hours: Number(ttl.value) || 24 });
      label.value = "";
      var tok = h("input", { class: "token", type: "text", readOnly: true, value: r.token, "aria-label": "Token" });
      tokenBox.replaceChildren(h("p", null, h("strong", { text: "Token for " + r.label }), h("br"), h("span", { class: "muted small", text: "Copy it now; it won't be shown again. Send it as Authorization: Bearer … to " + location.origin + "/mcp or the API." })), tok,
        h("div", { class: "row" }, h("button", { type: "button", onclick: function () { tok.select(); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tok.value).then(function () { toast("Token copied"); }, function () { toast("Copy failed; select and copy manually"); }); else toast("Select the token and copy it manually"); } }, icon("copy"), "Copy token"),
          h("button", { type: "button", class: "secondary", onclick: function () { tokenBox.replaceChildren(); tokenBox.hidden = true; } }, "Done")));
      tokenBox.hidden = false;
      load();
    } catch (err) { showErr(msg, err); }
  } },
    h("div", { class: "grid2" }, h("label", null, "Project", proj), h("label", null, "Label", label)),
    h("div", { class: "row" }, h("label", null, canWrite, "Can edit"), h("label", null, "Expires after", ttl, "hours"), h("span", { class: "spacer" }), h("button", { type: "submit" }, "Create token")));
  var bmsg = h("p", { class: "msg", role: "status" });
  var bproj = h("select", { "aria-label": "Project to back up" });
  var backupBtn = h("button", { type: "button", class: "secondary", onclick: async function () {
    backupBtn.disabled = true;
    try {
      var pid = bproj.value;
      var r = await api("GET", "/api/projects/" + enc(pid) + "/backup");
      var blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = h("a", { href: url, download: "agent-library-" + pid + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      toast("Backup downloaded (" + fmtBytes(blob.size) + ")");
    } catch (err) { showErr(bmsg, err); }
    backupBtn.disabled = false;
  } }, icon("download"), "Download backup");
  shell([{ t: "Connections" }], connHead(), settingsTabs("tokens"),
    h("div", { class: "callout" }, icon("key"), h("span", null, h("strong", { text: "Agent tokens (advanced)" }), " are for your own scripts or local agents that can't sign in. Each token covers one project, expires, and can be revoked immediately. Most apps should connect as a reader app instead.")),
    msg, list, h("p", null, h("label", { class: "muted small" }, showAll, "Show revoked and expired")),
    h("details", null, h("summary", { text: "Create a token" }), h("div", { class: "card" }, form)), tokenBox,
    h("details", null, h("summary", { text: "Backup" }), h("div", { class: "card" }, h("p", { class: "muted small", text: "Download a JSON backup of a project's documents and history." }), h("div", { class: "row" }, bproj, backupBtn), bmsg)));
  load().then(function () { projects.forEach(function (p) { bproj.append(h("option", { value: p.id, text: p.title })); }); });
}

// ---------- settings: API keys (alk_ credentials for REST clients such as Muse) ----------
var API_BASE_HINT = "See your installation configuration";
function daysLeft(iso) { return Math.ceil((Date.parse(iso) - Date.now()) / 86400000); }
function secretBox(box, title, secret, note) {
  var tok = h("input", { class: "token", type: "text", readOnly: true, value: secret, "aria-label": "API key" });
  box.replaceChildren(h("p", null, h("strong", { text: title }), h("br"), h("span", { class: "muted small", text: note })), tok,
    h("div", { class: "row" }, h("button", { type: "button", onclick: function () { tok.select(); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tok.value).then(function () { toast("Key copied"); }, function () { toast("Copy failed; select and copy manually"); }); else toast("Select the key and copy it manually"); } }, icon("copy"), "Copy key"),
      h("button", { type: "button", class: "secondary", onclick: function () { box.replaceChildren(); box.hidden = true; } }, "Done")));
  box.hidden = false;
}
// Per-project access picker: one row per owner project, "No access" / "Read" / "Read & edit".
function scopePicker(projects, current) {
  var rows = projects.map(function (p) {
    var cur = (current || []).find(function (c) { return c.project_id === p.id; });
    var sel = h("select", { "aria-label": "Access to " + p.title, dataset: { pid: p.id } },
      h("option", { value: "", text: "No access" }), h("option", { value: "read", text: "Read" }), h("option", { value: "read_write", text: "Read & edit" }));
    sel.value = cur ? cur.access : "";
    var row = h("label", { class: "scope-row" }, h("span", { class: "scope-name", text: p.title }), sel);
    function mark() { row.classList.toggle("on", !!sel.value); summary(); }
    sel.addEventListener("change", mark);
    row.mark = mark;
    return row;
  });
  var count = h("span", { class: "scope-count" });
  function summary() {
    var n = rows.filter(function (r) { return r.querySelector("select").value; }).length;
    count.textContent = n ? n + " of " + rows.length + " selected" : "None selected";
  }
  rows.forEach(function (r) { r.mark(); });
  return { el: h("div", { class: "scope-wrap" },
    h("div", { class: "scope-head" }, h("span", { text: "Projects and access" }), count),
    h("div", { class: "scope" }, rows)), value: function () {
    return rows.map(function (r) { var s = r.querySelector("select"); return s.value ? { project_id: s.dataset.pid, access: s.value } : null; }).filter(Boolean);
  } };
}
async function viewApiKeys() {
  var msg = h("p", { class: "msg", role: "status" });
  var list = h("ul", { class: "list" });
  var showAll = h("input", { type: "checkbox" });
  var box = h("div", { class: "card", hidden: true });
  var data = null, projects = [];
  var label = h("input", { type: "text", placeholder: "Label, e.g. Muse", required: true, maxLength: 80, "aria-label": "Key label" });
  function lifeSelect(dflt) {
    var s = h("select", { "aria-label": "Lifetime" }, [1, 7, 30, 90].map(function (d) { return h("option", { value: String(d), text: d === 1 ? "1 day" : d + " days" }); }));
    s.value = String(dflt || 90); return s;
  }
  var life = lifeSelect(90);
  var picker = null, pickerHost = h("div");
  function draw() {
    list.replaceChildren();
    var ks = data.keys.filter(function (k) { return showAll.checked || k.status === "active"; });
    if (!ks.length) list.append(h("li", { class: "empty", text: "No active API keys." }));
    ks.forEach(function (k) {
      var left = daysLeft(k.expires_at);
      var exp = k.status === "active" ? (left <= 1 ? "expires within a day" : "expires in " + left + " days") + " (" + fmtDate(k.expires_at) + ")" : k.status;
      var li = h("li", null,
        h("div", { class: "grow" }, h("strong", { text: k.label }),
          h("small", { text: k.projects.map(function (p) { return p.title + " (" + (p.access === "read_write" ? "read & edit" : "read") + ")"; }).join(", ") || "no projects" }),
          h("small", { class: "muted" + (k.status === "active" && left <= 14 ? " warn" : ""), text: exp + " · " + (k.last_used_at ? "last used " + fmtDate(k.last_used_at) : "never used") + (k.replaces_id ? " · replacement key" : "") })),
        statusBadge(k.status));
      if (k.status === "active") {
        var editHost = h("div", { class: "card", hidden: true });
        li.append(h("span", { class: "row" },
          h("button", { type: "button", class: "secondary", onclick: async function (e) {
            var nl = lifeSelect(90);
            editHost.hidden = false;
            editHost.replaceChildren(h("p", { class: "small", text: "Create a replacement with the same projects and access. The current key keeps working until you revoke it, so you can update the app first." }),
              h("div", { class: "row" }, h("label", null, "New key lifetime", nl), h("span", { class: "spacer" }),
                h("button", { type: "button", onclick: async function (ev) {
                  ev.target.disabled = true;
                  try {
                    var r = await api("POST", "/api/api-keys/" + enc(k.id) + "/replace", { lifetime_days: Number(nl.value) });
                    editHost.hidden = true;
                    secretBox(box, "Replacement key for " + r.label, r.secret, "Copy it now; it won't be shown again. Put it in the app, check it works, then revoke the old key (listed below).");
                    load();
                  } catch (err) { showErr(msg, err); ev.target.disabled = false; }
                } }, "Create replacement"),
                h("button", { type: "button", class: "secondary", onclick: function () { editHost.hidden = true; } }, "Cancel")));
          } }, "Replace"),
          h("button", { type: "button", class: "secondary", onclick: function () {
            var sp = scopePicker(projects, k.projects);
            editHost.hidden = false;
            editHost.replaceChildren(h("p", { class: "small", text: "Choose which projects this key can use. Adding projects gives the app new access immediately." }), sp.el,
              h("div", { class: "row" }, h("span", { class: "spacer" }),
                h("button", { type: "button", onclick: async function (ev) {
                  var next = sp.value();
                  if (!next.length) { showErr(msg, { message: "Pick at least one project, or revoke the key instead." }); return; }
                  var added = next.filter(function (n) { var c = k.projects.find(function (x) { return x.project_id === n.project_id; }); return !c || (c.access === "read" && n.access === "read_write"); });
                  if (added.length && !confirm("Give \"" + k.label + "\" new access to " + added.length + " project(s)? The app can use it immediately.")) return;
                  ev.target.disabled = true;
                  try { await api("PUT", "/api/api-keys/" + enc(k.id) + "/scope", { projects: next, confirm_new_access: added.length > 0 }); toast("Access updated"); load(); }
                  catch (err) { showErr(msg, err); ev.target.disabled = false; }
                } }, "Save access"),
                h("button", { type: "button", class: "secondary", onclick: function () { editHost.hidden = true; } }, "Cancel")));
          } }, "Projects"),
          h("button", { type: "button", class: "danger", onclick: async function (e) {
            if (!confirm("Revoke \"" + k.label + "\"? Anything using it loses access immediately.")) return;
            e.target.disabled = true;
            try { await api("POST", "/api/api-keys/" + enc(k.id) + "/revoke", {}); toast("Revoked " + k.label); load(); }
            catch (err) { showErr(msg, err); e.target.disabled = false; }
          } }, "Revoke")), editHost);
      }
      list.append(li);
    });
  }
  async function load() {
    try {
      var r = await Promise.all([api("GET", "/api/api-keys"), api("GET", "/api/projects")]);
      data = r[0]; projects = r[1].projects;
      projects.forEach(function (p) { projectTitles[p.id] = p.title; });
      if (!picker) { picker = scopePicker(projects, []); pickerHost.replaceChildren(picker.el); }
      draw();
    } catch (err) { showErr(msg, err); }
  }
  showAll.addEventListener("change", function () { if (data) draw(); });
  var form = h("form", { onsubmit: async function (e) {
    e.preventDefault();
    var scope = picker ? picker.value() : [];
    if (!scope.length) { showErr(msg, { message: "Pick at least one project." }); return; }
    try {
      var r = await api("POST", "/api/api-keys", { label: label.value.trim(), lifetime_days: Number(life.value), projects: scope });
      label.value = "";
      secretBox(box, "API key for " + r.label, r.secret, "Copy it now; it won't be shown again. Base URL: " + API_BASE_HINT + " · expires " + fmtDate(r.expires_at) + ".");
      load();
    } catch (err) { showErr(msg, err); }
  } },
    h("div", { class: "grid2" }, h("label", null, "Label", label), h("label", null, "Lifetime", life)),
    pickerHost,
    h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { type: "submit" }, "Create key")));
  shell([{ t: "Connections" }], connHead(), settingsTabs("api-keys"),
    h("div", { class: "callout" }, icon("key"), h("span", null, h("strong", { text: "API keys" }), " are for apps that use the REST API (for example Muse). Each key covers only the projects you pick, expires (90 days at most) and can be replaced or revoked at any time. The key itself is shown once.")),
    msg, box, list, h("p", null, h("label", { class: "muted small" }, showAll, "Show revoked and expired")),
    h("details", null, h("summary", { text: "Create an API key" }), h("div", { class: "card" }, form)));
  load();
}

// Canonical browser link for a document (same route shape as src/links.ts: /p/:pid/a/:aid).
function docUrl(pid, aid) { return location.origin + "/p/" + enc(pid) + "/a/" + enc(aid); }
// Quick-copy icons: link, title and (for Markdown) the current editor text; extra icons appended by callers.
function copyBar(A, getContents, extra) {
  return h("span", { class: "icons" },
    copyIcon("link", "Copy link", function () { return docUrl(A.pid, A.aid) + (isTextDoc(A.meta.kind) && A.tab === "preview" ? "/preview" : ""); }),
    copyIcon("type", "Copy title", function () { return A.meta.title; }),
    getContents ? copyIcon("copy", "Copy contents", getContents) : null, favoriteButton(A.pid, A.aid), extra || null);
}

// ---------- artifact view (Markdown editor or binary preview) ----------
async function viewArtifact(pid, aid, initialTab) {
  var base = "/api/projects/" + enc(pid) + "/artifacts/" + enc(aid);
  var msg = h("p", { class: "msg", role: "status" });
  shell(projCrumbs(pid, [{ t: "Loading…" }]), h("div", { class: "doc-loading", "aria-busy": "true" }, h("span", { class: "sr", text: "Loading document…" }),
    h("span", { class: "skel-line wide", "aria-hidden": "true" }), h("span", { class: "skel-line", "aria-hidden": "true" }), h("div", { class: "skel-block", "aria-hidden": "true" })));
  ensureProjectTitle(pid);
  var data;
  try { data = await api("GET", base); }
  catch (err) {
    if (err.status === 401) return;
    var gone = err.status === 404 || err.status === 403;
    shell(projCrumbs(pid, [{ t: gone ? "Not available" : "Couldn't load" }]), gone
      ? stateBox("error", "alert", "This item isn't available", "It may have been moved to trash or removed, or this account can't open it. (" + err.message + ")", [h("a", { class: "btn secondary", href: "#/p/" + enc(pid) }, "Back to project"), h("a", { class: "btn ghost", href: "#/p/" + enc(pid) + "/trash" }, "Check trash")])
      : stateBox("error", "alert", "Couldn't open this document", (err.status === 0 ? "You appear to be offline." : err.message) + " Nothing was changed.", h("button", { type: "button", class: "secondary", onclick: function () { route(); } }, icon("refresh"), "Try again")));
    return;
  }
  if (!S.me || location.hash.indexOf(enc(aid)) < 0) return;
  var A = { pid: pid, aid: aid, base: base, meta: data.artifact, rev: data.revision.rev, alive: true };
  offTouch(pid, aid);
  S.cleanups.push(function () { A.alive = false; });
  var titleEl = h("h1", { text: A.meta.title });
  var metaMsg = h("p", { class: "msg", role: "status" });

  // metadata: rename / folder / tags / trash, guarded by expected_meta_version
  var fTitle = h("input", { type: "text", maxLength: 200 }), fFolder = h("input", { type: "text", maxLength: 200 }), fTags = h("input", { type: "text", placeholder: "comma,separated" });
  var fDescription = A.meta.is_template ? h("input", { type: "text", maxLength: 280, "aria-label": "Template description", value: A.meta.template_description || "" }) : null;
  function fillMeta() {
    if (document.activeElement !== fTitle) fTitle.value = A.meta.title;
    if (document.activeElement !== fFolder) fFolder.value = A.meta.folder || "";
    if (document.activeElement !== fTags) fTags.value = (A.meta.tags || []).join(", ");
    if (fDescription && document.activeElement !== fDescription) fDescription.value = A.meta.template_description || "";
    if (A.templateSourceNote) {
      A.templateSourceNote.hidden = !A.meta.source;
      A.templateSourceNote.replaceChildren();
      if (A.meta.source) A.templateSourceNote.append(h("a", { href: "#/p/" + enc(pid) + "/a/" + enc(A.meta.source.artifact_id) + "?v=" + A.meta.source.revision, text: (A.meta.source.role === "template" ? "Created from " : "Copied from ") + A.meta.source.title + " · v" + A.meta.source.revision }));
    }
    titleEl.textContent = A.meta.title;
    setCrumbs(projCrumbs(pid, [{ t: A.meta.title }]));
  }
  async function reloadMeta() { try { var r = await api("GET", base); A.meta = r.artifact; fillMeta(); } catch (e) {} }
  async function patchMeta(fields, okText) {
    try {
      var r = await api("PATCH", base, Object.assign({ expected_meta_version: A.meta.meta_version }, fields), { key: uuid() });
      if (fDescription) A.meta.template_description = r.template_description;
      A.meta.meta_version = r.meta_version; A.meta.title = r.title; A.meta.folder = r.folder; A.meta.tags = r.tags; A.meta.trashed = r.trashed;
      fillMeta(); showMsg(metaMsg, okText, true); return r;
    } catch (err) {
      if (err.status === 409) { showMsg(metaMsg, "Details were changed elsewhere (now version " + (err.data.error.current_meta_version || "?") + "). Reloaded; review and try again."); await reloadMeta(); }
      else showErr(metaMsg, err);
      return null;
    }
  }
  var details = h("details", null, h("summary", { text: "Details" }),
    h("div", { class: "grid2" }, h("label", null, "Title", fTitle), h("label", null, "Folder", fFolder), h("label", null, "Tags", fTags), fDescription ? h("label", null, "Template description", fDescription) : null),
    h("div", { class: "row" },
      h("button", { type: "button", onclick: function () {
        patchMeta({ ...(fDescription ? { template_description: fDescription.value } : {}), title: fTitle.value.trim(), folder: fFolder.value.trim(), tags: fTags.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) }, "Details saved.");
      } }, "Save details"),
      h("button", { type: "button", class: "danger", onclick: async function () {
        if (!confirm("Move \"" + A.meta.title + "\" to trash? History is kept and it can be restored.")) return;
        if (A.flush) await A.flush();
        var r = await patchMeta({ trashed: true }, "Moved to trash.");
        if (r) location.hash = "#/p/" + enc(pid) + "/trash";
      } }, "Move to trash")),
    h("p", { class: "muted small", text: "ID " + aid + " - " + A.meta.kind }), metaMsg);
  if (A.meta.kind === "markdown") {
    var templateForm = h("div", { hidden: true, class: "card" });
    var saveTemplateBtn = h("button", { type: "button", class: "secondary", onclick: async function () {
      saveTemplateBtn.disabled = true;
      try {
        // Capture the visible editor's saved revision; unsaved content is not silently copied.
        var pinned = A.rev;
        var preview = await api("GET", base + "/preview?rev=" + pinned);
        var name = h("input", { type: "text", required: true, maxLength: 200, value: A.meta.title, "aria-label": "Template name" });
        var desc = h("input", { type: "text", maxLength: 280, "aria-label": "New template description" });
        var previewBox = h("div", { class: "template-preview prose", tabIndex: 0, "aria-label": "Source template preview" });
        previewBox.innerHTML = preview.html;
        var smsg = h("p", { class: "msg", role: "status" }), attempt = null, busy = false;
        var submit = h("button", { type: "submit" }, "Save template");
        templateForm.replaceChildren(h("form", { class: "template-form", onsubmit: async function (e) {
          e.preventDefault(); if (busy) return;
          var req = { source_artifact_id: aid, source_revision: pinned, title: name.value.trim(), description: desc.value };
          var signature = JSON.stringify(req); if (!attempt || attempt.signature !== signature) attempt = { signature: signature, key: uuid() };
          busy = true; submit.disabled = true;
          try {
            var r = await api("POST", "/api/projects/" + enc(pid) + "/templates", req, { key: attempt.key });
            location.hash = "#/p/" + enc(pid) + "/a/" + enc(r.artifact_id) + "/edit";
          } catch (err) { showErr(smsg, err); }
          finally { busy = false; submit.disabled = false; }
        } }, h("label", null, "Template name", name), h("label", null, "Description (optional)", desc),
          h("p", { class: "muted small", text: "Project: " + (projectTitles[pid] || pid) + ". Copies saved revision v" + pinned + " shown below. Unsaved edits are excluded. {{title}}, {{project}} and {{date}} are replaced once when used; other braces stay literal." }),
          previewBox, h("div", { class: "row" }, submit, h("button", { type: "button", class: "secondary", onclick: function () { templateForm.hidden = true; saveTemplateBtn.focus(); } }, "Cancel")), smsg));
        templateForm.hidden = false; name.focus();
      } catch (err) { showErr(metaMsg, err); }
      finally { saveTemplateBtn.disabled = false; }
    } }, "Save as template");
    var detailActions = details.querySelector(".row");
    detailActions.insertBefore(saveTemplateBtn, detailActions.lastElementChild);
    details.append(templateForm);
  }
  fillMeta();

  // shared panels
  var panels = {}, tabBtns = {};
  var tabNav = tabList("Document views");
  function addTab(name, label, onShow) {
    panels[name] = h("section", { hidden: true });
    tabBtns[name] = tabButton(label, panels[name], function () { showTab(name); });
    tabBtns[name].onShow = onShow;
    tabNav.append(tabBtns[name]);
  }
  function showTab(name) {
    for (var k in panels) panels[k].hidden = k !== name;
    selectTab(tabNav, tabBtns[name]);
    A.tab = name;
    if (isTextDoc(A.meta.kind) && (name === "preview" || name === "edit")) {
      var want = "#/p/" + enc(pid) + "/a/" + enc(aid) + (name === "edit" ? "/edit" : "");
      if (location.hash !== want) history.replaceState(null, "", want);
    }
    if (tabBtns[name].onShow) tabBtns[name].onShow();
  }

  // history
  var histMsg = h("p", { class: "msg", role: "status" }), histList = h("ul", { class: "list" }), histView = h("div");
  async function loadHistory() {
    try {
      var r = await api("GET", base + "/history");
      histList.replaceChildren();
      r.revisions.forEach(function (v) {
        var li = h("li", null, h("strong", { text: "rev " + v.rev }),
          h("span", { class: "grow muted small", text: fmtDate(v.created_at) + " - " + fmtBytes(v.size) + " - " + (v.author_id || "") + (v.restored_from ? " - restored from rev " + v.restored_from : "") }),
          h("button", { type: "button", class: "secondary", onclick: function () { viewRev(v); } }, "View"));
        if (v.rev !== A.rev) li.append(h("button", { type: "button", onclick: function () { restoreRev(v.rev); } }, "Restore as new revision"));
        else li.append(h("span", { class: "badge", text: "current" }));
        histList.append(li);
      });
    } catch (err) { showErr(histMsg, err); }
  }
  async function viewRev(v) {
    histView.replaceChildren();
    if (isTextDoc(A.meta.kind)) {
      try { var r = await api("GET", base + "?rev=" + v.rev); histView.append(h("h2", { text: "Revision " + v.rev + " (source)" }), h("pre", { class: "raw", text: r.body })); }
      catch (err) { showErr(histMsg, err); }
    } else {
      var url = base + "/content?rev=" + v.rev;
      histView.append(h("h2", { text: "Revision " + v.rev }), mediaFor(v.mime, url, A.meta.title));
    }
  }
  async function restoreRev(n) {
    if (A.isBusy && A.isBusy()) { showMsg(histMsg, "Save or discard your local edits before restoring an older revision."); return; }
    if (!confirm("Restore revision " + n + " as a new revision? Current history is kept.")) return;
    try {
      var r = await api("POST", base + "/restore", { expected_revision: A.rev, from_revision: n }, { key: uuid() });
      showMsg(histMsg, "Restored rev " + n + " as rev " + r.revision + ".", true);
      if (A.reload) await A.reload();
      loadHistory();
    } catch (err) {
      if (err.status === 409) showMsg(histMsg, "The artifact changed (server is at rev " + ((err.data.error || {}).current_revision || "?") + "). Reload and try again.");
      else showErr(histMsg, err);
    }
  }
  // comments
  var comMsg = h("p", { class: "msg", role: "status" }), comList = h("ul", { class: "list" }), comText = h("textarea", { class: "half", maxLength: 4000, placeholder: "Comment on the current revision" });
  var comPending = null;
  async function loadComments() {
    try {
      var r = await api("GET", base + "/comments");
      comList.replaceChildren();
      if (!r.comments.length) comList.append(h("li", { class: "empty", text: "No comments yet." }));
      r.comments.forEach(function (c) {
        comList.append(h("li", null, h("div", { class: "grow" }, h("div", { class: "muted small", text: (c.author || "") + " - rev " + c.revision + " - " + fmtDate(c.created_at) }), h("div", { class: "raw-text", text: c.body }))));
      });
    } catch (err) { showErr(comMsg, err); }
  }
  var comForm = h("form", { onsubmit: async function (e) {
    e.preventDefault();
    var t = comText.value.trim(); if (!t) return;
    if (!comPending || comPending.t !== t || comPending.rev !== A.rev) comPending = { t: t, rev: A.rev, key: uuid() };
    try { await api("POST", base + "/comments", { revision: comPending.rev, body: t }, { key: comPending.key }); comPending = null; comText.value = ""; showMsg(comMsg, "", true); loadComments(); }
    catch (err) { showErr(comMsg, err); }
  } }, comText, h("div", { class: "row" }, h("button", { type: "submit" }, "Add comment")));

  var below = h("div", { class: "below" });
  if (isTextDoc(A.meta.kind)) renderMarkdownEditor(A, data, { titleEl: titleEl, details: details, tabNav: tabNav, panels: panels, addTab: addTab, showTab: showTab, fillMeta: fillMeta, below: below });
  else if (isDataKind(A.meta.kind)) renderDataFile(A, data, { titleEl: titleEl, details: details, tabNav: tabNav, panels: panels, addTab: addTab, showTab: showTab, below: below });
  else renderBinary(A, data, { titleEl: titleEl, details: details, tabNav: tabNav, panels: panels, addTab: addTab, showTab: showTab, below: below });

  addTab("history", "History", loadHistory);
  panels.history.append(histMsg, histList, histView);
  addTab("comments", "Comments", loadComments);
  panels.comments.append(comList, comForm, comMsg);
  for (var k in panels) app.append(panels[k]);
  app.append(below);
  // Documents open on the rendered view; Edit is one tap away (and /edit deep links open the editor).
  showTab(isTextDoc(A.meta.kind) && initialTab === "edit" ? "edit" : "preview");
  resumeApply("artifact");
}

function downloadUrl(url) { return url + (url.indexOf("?") < 0 ? "?" : "&") + "download=1"; }
// Full-size image overlay: Escape / click outside / Close dismisses; focus returns to the opener.
// ---------- rendered Markdown tables ----------
// The server emits plain semantic tables (thead/th scope=col/tbody). On the client each table gets a scroll
// container that is a labelled, keyboard-focusable region; horizontal scrolling stays inside it, never the page.
// Edge shadows and a "scroll" hint appear only while columns are actually hidden. Tables with 3+ columns can
// switch to "Rows as cards" (each row stacked, every value prefixed by its column header), a reading aid only:
// the table DOM and semantics, copy and export are unchanged.
var tableSeq = 0, cardTables = {}; // cardTables: "<route>#<table index>" -> true while shown as cards (kept across preview refreshes)
// Long unbroken tokens (paths, globs, URLs, identifiers) get <wbr> break hints after separators so a column can
// wrap at natural points instead of growing to the token's full width. <wbr> adds no characters: copied text and
// the stored document are unchanged.
function softBreakLongTokens(cell) {
  var walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT), nodes = [], n;
  while ((n = walker.nextNode())) if (/\S{22,}/.test(n.nodeValue)) nodes.push(n);
  nodes.forEach(function (node) {
    var frag = document.createDocumentFragment();
    node.nodeValue.split(/(\S{22,})/).forEach(function (part, k) {
      if (k % 2 === 0) { if (part) frag.appendChild(document.createTextNode(part)); return; }
      // Break opportunity after each separator (no regex lookbehind: older Safari can't parse it).
      part.split(/([\/._\-:?&=,])/).forEach(function (seg, j) {
        if (!seg) return;
        frag.appendChild(document.createTextNode(seg));
        if (j % 2 === 1) frag.appendChild(document.createElement("wbr"));
      });
    });
    node.parentNode.replaceChild(frag, node);
  });
}
function enhanceTables(root) {
  // A refreshed preview replaces its tables: release the previous observers/listeners first.
  (root.tableCleanups || []).forEach(function (f) { f(); }); root.tableCleanups = [];
  var route = (location.hash || "").replace(/\/(edit|preview)$/, "");
  root.querySelectorAll("table").forEach(function (t, index) {
    if (t.parentNode && t.parentNode.classList && t.parentNode.classList.contains("table-scroll")) return;
    var n = ++tableSeq, heads = Array.prototype.map.call(t.tHead ? t.tHead.rows[0].cells : [], function (c) { return c.textContent.trim(); });
    var label = heads.length ? "Table: " + heads.slice(0, 3).join(", ") + (heads.length > 3 ? ", …" : "") : "Table " + n;
    var scroller = h("div", { class: "table-scroll", role: "region", "aria-label": label });
    var hint = h("p", { class: "table-hint", id: "table-hint-" + n, hidden: true, text: heads.length + " columns · scroll sideways to see all columns" });
    var bar = h("div", { class: "table-tools" }, hint);
    var wrap = h("div", { class: "table-wrap" }, bar, scroller);
    t.parentNode.insertBefore(wrap, t); scroller.appendChild(t);
    Array.prototype.forEach.call(t.querySelectorAll("td, th"), softBreakLongTokens);
    var toggle = null, key = route + "#" + index;
    // Only a table that hides columns gets a tab stop, a description and the cards option (cards mode keeps its toggle).
    function update() {
      var cards = wrap.classList.contains("as-cards"), over = !cards && scroller.scrollWidth - scroller.clientWidth > 1, x = scroller.scrollLeft;
      hint.hidden = !over;
      if (over) { scroller.tabIndex = 0; scroller.setAttribute("aria-describedby", hint.id); }
      else { if (document.activeElement !== scroller) scroller.removeAttribute("tabindex"); scroller.removeAttribute("aria-describedby"); }
      if (toggle) toggle.hidden = !over && !cards;
      wrap.classList.toggle("more-left", over && x > 1);
      wrap.classList.toggle("more-right", over && x < scroller.scrollWidth - scroller.clientWidth - 1);
    }
    scroller.addEventListener("scroll", update, { passive: true });
    if (heads.length >= 3 && t.tBodies.length) {
      // Cards: label every cell with its column header (data-label) for the stacked layout.
      Array.prototype.forEach.call(t.tBodies[0].rows, function (r) { Array.prototype.forEach.call(r.cells, function (c, k) { if (heads[k]) c.dataset.label = heads[k]; }); });
      var setCards = function (on) {
        // Presentation only: the table element, its header cells and its text stay as they are. Card CSS changes the
        // display of table parts, which can drop native table semantics in some browsers, so explicit ARIA table roles
        // keep "row N, column <header>" navigation working while cards are shown.
        wrap.classList.toggle("as-cards", on); toggle.setAttribute("aria-pressed", String(on));
        var set = function (el, role) { if (on) el.setAttribute("role", role); else el.removeAttribute("role"); };
        set(t, "table");
        Array.prototype.forEach.call(t.querySelectorAll("thead, tbody"), function (g) { set(g, "rowgroup"); });
        Array.prototype.forEach.call(t.rows, function (r) { set(r, "row"); Array.prototype.forEach.call(r.cells, function (c) { set(c, c.tagName === "TH" ? "columnheader" : "cell"); }); });
        if (on) cardTables[key] = true; else delete cardTables[key];
        update();
      };
      toggle = h("button", { type: "button", class: "table-toggle", "aria-pressed": "false", hidden: true, onclick: function () { setCards(!wrap.classList.contains("as-cards")); } }, "Rows as cards");
      bar.appendChild(toggle);
      if (cardTables[key]) setCards(true);
    }
    update();
    var stop;
    if (window.ResizeObserver) { var ro = new ResizeObserver(update); ro.observe(scroller); stop = function () { ro.disconnect(); }; }
    else { window.addEventListener("resize", update); stop = function () { window.removeEventListener("resize", update); }; }
    root.tableCleanups.push(stop); S.cleanups.push(stop);
  });
}
function openLightbox(src, title) {
  var opener = document.activeElement;
  var img = h("img", { src: src, alt: title || "image" });
  // Fill the viewport (contain); crisp scaling for tiny images. Natural size is shown in the caption.
  img.addEventListener("load", function () { if (img.naturalWidth < 300) img.classList.add("small"); cap.textContent = (title || "") + " - " + img.naturalWidth + "x" + img.naturalHeight; });
  var cap = h("span", { class: "cap", text: title || "" });
  var close;
  var box = h("div", { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": title || "Image" },
    h("div", { class: "bar" }, cap,
      iconLink("external", "Open original", src, { target: "_blank", rel: "noopener" }),
      iconLink("download", "Download", downloadUrl(src), { download: title || "image.png" }),
      close = iconButton("x", "Close", function () { done(); })),
    img);
  function onKey(e) { if (e.key === "Escape") done(); }
  function done() { document.removeEventListener("keydown", onKey); box.remove(); if (opener && opener.focus) opener.focus(); }
  box.addEventListener("click", function (e) { if (e.target === box) done(); });
  document.addEventListener("keydown", onKey);
  document.body.append(box);
  close.focus();
}

// version: label of an older version shown in History ("v3"), for data-file messages.
function mediaFor(mime, url, title, version) {
  var wrap = h("div", { class: "media" });
  var dl = h("p", { class: "row" }, h("a", { class: "btn secondary", href: downloadUrl(url), download: title || "download" }, icon("download"), "Download"));
  var fail = function () { wrap.replaceChildren(h("p", { class: "banner", text: "Preview could not be displayed in this browser. Use the download link instead." }), dl); };
  if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) {
    wrap.append(h("img", { src: url, alt: title || "image", tabIndex: 0, title: "View full size", onerror: fail,
      onclick: function () { openLightbox(url, title); }, onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(url, title); } } }), dl);
    dl.prepend(h("button", { type: "button", class: "secondary", onclick: function () { openLightbox(url, title); } }, icon("expand"), "View full size"));
  }
  else if (mime === "video/mp4" || mime === "video/webm") wrap.append(h("video", { src: url, controls: true, playsInline: true, preload: "metadata", onerror: fail }), dl);
  else if (mime === "application/pdf") {
    // Opens the raw file in a new tab so the browser's own PDF viewer shows it (never embedded in the app).
    var openUrl = url + (url.indexOf("?") < 0 ? "?" : "&") + "open=1";
    wrap.append(h("div", { class: "filecard" }, h("span", { class: "ficon" }, icon("file")),
      h("div", { class: "grow" }, h("strong", { text: title || "PDF" }), h("div", { class: "muted small", text: "PDF document" })),
      h("a", { class: "btn", href: openUrl, target: "_blank", rel: "noopener" }, icon("external"), "Open"),
      h("a", { class: "btn secondary", href: downloadUrl(url), download: title || "document.pdf" }, icon("download"), "Download")));
  }
  else if (mime === "text/csv" || mime === "application/json") {
    // Older versions of a data file (History): fetch the text and show the same read-only preview.
    var box = h("p", { class: "muted", text: "Loading preview…" });
    wrap.append(box, dl);
    fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (t) { box.replaceWith(dataPreview(mime === "text/csv" ? "csv" : "json", t, { size: utf8Len(t), download: downloadUrl(url), title: title, problemHint: "Use Show full text to see it as stored.", rawHint: "Show full text shows exact values" })); },
        function (e) { wrap.replaceChildren(h("p", { class: "banner", text: "Couldn't load " + (version || "this version") + " (" + e.message + "). Use Download instead." }), dl); });
  }
  else wrap.append(h("p", { class: "muted", text: "No inline preview for " + mime + "." }), dl);
  return wrap;
}

function renderBinary(A, data, ui) {
  var info = h("p", { class: "muted small" });
  var holder = h("div");
  function draw(d) {
    A.rev = d.revision.rev; A.meta = d.artifact;
    var kinds = { "application/pdf": "PDF", "image/png": "PNG image", "image/jpeg": "JPEG image", "image/webp": "WebP image", "image/gif": "GIF image", "video/mp4": "MP4 video", "video/webm": "WebM video" };
    info.textContent = (kinds[d.revision.mime] || d.revision.mime) + " · " + fmtBytes(d.revision.size) + " · rev " + d.revision.rev + " · updated " + fmtDate(d.revision.created_at);
    info.title = "sha256 " + d.revision.sha256;
    holder.replaceChildren(mediaFor(d.revision.mime, d.content_url, d.artifact.title));
  }
  A.reload = async function () { draw(await api("GET", A.base)); };
  draw(data);
  shell(projCrumbs(A.pid, [{ t: A.meta.title }]), h("div", { class: "titlebar" }, ui.titleEl, copyBar(A, null, offlineToggle(A))), info, ui.tabNav);
  ui.below.append(ui.details);
  ui.addTab("preview", "Preview", null);
  ui.panels.preview.append(holder);
  if (/^(image|video)\//.test(data.revision.mime)) {
    var md = "![" + A.meta.title.replace(/[\[\]]/g, "") + "](" + A.aid + ")";
    ui.panels.preview.append(h("p", { class: "muted small" }, "Embed in a document of this project: ",
      h("code", { text: md }), " ", copyIcon("copy", "Copy Markdown embed", function () { return md; }),
      " or in HTML ", h("code", { text: (/^video/.test(data.revision.mime) ? '<video src="' : '<img src="') + A.aid + '">' })));
  }
  ui.below.prepend(h("details", null, h("summary", { text: "Replace with a new version" }),
    uploadForm(A.pid, function () { return { artifact_id: A.aid, expected_revision: A.rev }; }, function () { A.reload(); })));
}

// ---------- data files (CSV / JSON): read-only previews ----------
// Agents and apps write these files, so their content is untrusted: every value reaches the page through text
// nodes (textContent), never as HTML. Rendering is bounded (rows, cells, tree nodes); Raw and Download give the rest.
var DATA_ROWS = 500, DATA_CELLS = 20000, DATA_COLS = 200, JSON_BATCH = 500, JSON_AUTO_NODES = 2000;
var MEASUREMENTS_SCHEMA = "agentlib.measurements/1";
function isDataKind(kind) { return kind === "csv" || kind === "json"; }
function fmtCount(n) { return Number(n).toLocaleString("en-US"); }
function plural(n, word) { return fmtCount(n) + " " + word + (n === 1 ? "" : "s"); }
// RFC 4180 with exactly the server's rules (parseCsv in src/formats.ts): comma separator, CRLF or LF rows (no bare
// CR), quoted fields with "" escapes and embedded commas/newlines, a header row of unique non-empty names, and
// every row as wide as the header. test/data-preview.test.mjs runs both parsers on one corpus so they agree.
function csvParse(text) {
  function bad(line, detail) { var e = new Error("Invalid CSV: " + detail + (line ? " (line " + line + ")" : "")); e.line = line; e.detail = detail; return e; }
  if (text.charCodeAt(0) === 0xfeff) throw bad(undefined, "byte order mark not allowed");
  var rows = [], i = 0, line = 1, n = text.length;
  while (i < n) {
    var startLine = line, cells = [];
    for (;;) {
      var cell = "";
      if (text[i] === '"') {
        i++;
        for (;;) {
          if (i >= n) throw bad(startLine, "unterminated quoted field");
          var c = text[i];
          if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } i++; break; }
          if (c === "\n") line++;
          cell += c; i++;
        }
        if (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") throw bad(line, "unexpected character after closing quote");
      } else {
        while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          if (text[i] === '"') throw bad(line, "quote inside unquoted field");
          cell += text[i++];
        }
      }
      cells.push(cell);
      if (i >= n) break;
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "\r") { if (text[i + 1] !== "\n") throw bad(line, "bare CR line ending"); i += 2; line++; break; }
      if (text[i] === "\n") { i++; line++; break; }
    }
    rows.push({ line: startLine, cells: cells });
  }
  if (!rows.length) throw bad(1, "header row required");
  var header = rows.shift().cells, seen = Object.create(null);
  header.forEach(function (name) {
    if (!name.trim()) throw bad(1, "empty header name");
    if (seen[name]) throw bad(1, "duplicate header \"" + name.slice(0, 40) + "\"");
    seen[name] = true;
  });
  rows.forEach(function (r) { if (r.cells.length !== header.length) throw bad(r.line, "expected " + header.length + " columns, found " + r.cells.length); });
  return { header: header, rows: rows };
}
// JSON numbers keep their source text where the browser exposes it (JSON.parse source text access), so a large
// integer or a value like 1.50 shows exactly as written rather than as a rounded double.
function RawNum(src) { this.src = src; }
var JSON_EXACT_NUMBERS = (function () { try { return JSON.parse("1", function (k, v, c) { return !!(c && c.source === "1"); }) === true; } catch (e) { return false; } })();
function jsonParse(text) {
  return JSON.parse(text, function (k, v, ctx) { return typeof v === "number" && ctx && typeof ctx.source === "string" ? new RawNum(ctx.source) : v; });
}
function isJsonContainer(v) { return v !== null && typeof v === "object" && !(v instanceof RawNum); }
function jsonCellText(v) { return v instanceof RawNum ? v.src : v === null || v === undefined ? "" : String(v); }
// An array of flat objects (or an agentlib.measurements/1 document's records) can also be shown as a table.
function jsonRecords(v) {
  var arr = Array.isArray(v) ? v : isJsonContainer(v) && !Array.isArray(v) && v.schema === MEASUREMENTS_SCHEMA && Array.isArray(v.records) ? v.records : null;
  if (!arr || !arr.length) return null;
  var cols = [], seen = Object.create(null);
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i];
    if (!isJsonContainer(o) || Array.isArray(o)) return null;
    var ks = Object.keys(o);
    for (var j = 0; j < ks.length; j++) {
      if (isJsonContainer(o[ks[j]])) return null;
      if (!seen[ks[j]]) { seen[ks[j]] = true; cols.push(ks[j]); if (cols.length > DATA_COLS) return null; }
    }
  }
  if (!cols.length) return null;
  return { header: cols, count: arr.length, row: function (i) { var o = arr[i]; return cols.map(function (c) { return Object.prototype.hasOwnProperty.call(o, c) ? jsonCellText(o[c]) : ""; }); } };
}
// Numeric-looking cells (right-aligned). The value is trimmed first and long cells are never tested, so the
// pattern has no surrounding whitespace runs to backtrack over (a cell of 100k spaces stays linear).
var NUMERIC_CELL = /^[-+]?(\d+|\d{1,3}(,\d{3})+)?(\.\d+)?([eE][-+]?\d+)?%?$/;
function isNumericCell(v) { if (v.length > 64) return false; v = v.trim(); return /\d/.test(v) && NUMERIC_CELL.test(v); }
function dataNote(text, download) {
  return h("p", { class: "data-note" }, text, download ? [" · ", h("a", { href: download, download: "" }, "Download for the full file")] : null);
}
// header: column names; rows: arrays of cell strings (already capped). Numeric columns are right-aligned.
function dataTable(header, rows, label) {
  var numeric = header.map(function (x, k) {
    var any = false;
    for (var r = 0; r < rows.length; r++) { var v = rows[r][k]; if (!v) continue; if (!isNumericCell(v)) return false; any = true; }
    return any;
  });
  var head = h("tr"), body = document.createElement("tbody"), frag = document.createDocumentFragment();
  header.forEach(function (name, k) { head.appendChild(h("th", { scope: "col", class: numeric[k] ? "num" : null, text: name })); });
  rows.forEach(function (r) {
    var tr = document.createElement("tr");
    for (var k = 0; k < header.length; k++) {
      var td = document.createElement("td");
      var val = r[k] == null ? "" : r[k];
      // Short unbroken tokens (timestamps, ids, codes) stay on one line instead of breaking at "-" or "/".
      if (numeric[k]) td.className = "num";
      else if (val.length <= 32 && !/\s/.test(val)) td.className = "tok";
      // Prose keeps a readable width; the table scrolls sideways instead of squeezing it into a tall sliver.
      else if (val.length > 24) td.className = "long";
      td.textContent = val;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  });
  body.appendChild(frag);
  return h("div", { class: "data-scroll", role: "region", tabIndex: 0, "aria-label": label }, h("table", { class: "data-table" }, h("thead", null, head), body));
}
// First rows of a (possibly large) record set, within the row and cell budgets, plus a note when capped.
function cappedTable(header, count, rowAt, label, download) {
  var cols = Math.min(header.length, DATA_COLS);
  var limit = Math.min(count, DATA_ROWS, Math.max(1, Math.floor(DATA_CELLS / Math.max(1, cols))));
  var rows = [];
  for (var i = 0; i < limit; i++) rows.push(rowAt(i).slice(0, cols));
  var out = [dataTable(header.slice(0, cols), rows, label)];
  var capped = [];
  if (limit < count) capped.push("Showing " + fmtCount(limit) + " of " + plural(count, "row"));
  if (cols < header.length) capped.push("first " + fmtCount(cols) + " of " + plural(header.length, "column"));
  if (capped.length) out.push(dataNote(capped.join(", "), download));
  return out;
}
function csvPreview(text, opts) {
  var p;
  try { p = csvParse(text); } catch (e) { return dataProblem(e.message, opts.problemHint); }
  return h("div", { class: "datafile" },
    h("p", { class: "data-summary", text: plural(p.rows.length, "row") + " · " + plural(p.header.length, "column") + (opts.size != null ? " · " + fmtBytes(opts.size) : "") }),
    cappedTable(p.header, p.rows.length, function (i) { return p.rows[i].cells; }, "CSV data: " + p.header.slice(0, 3).join(", ") + (p.header.length > 3 ? ", …" : ""), opts.download));
}
// hint: what to do next; defaults to the file page's Raw tab (History and load errors pass their own).
function dataProblem(message, hint) {
  return h("div", { class: "datafile" }, h("p", { class: "banner", role: "status", text: message + ". " + (hint || "The Raw tab shows the file exactly as stored.") }));
}
// Invalid JSON: the browser's own message differs per engine; report a line and column where it gives a position.
function jsonErrorText(e, text) {
  var msg = e && e.message || "", lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return "Invalid JSON near line " + lc[1] + ", column " + lc[2];
  var m = /position (\d+)/.exec(msg);
  if (!m) return "Invalid JSON";
  var pos = Math.min(Number(m[1]), text.length), before = text.slice(0, pos), line = before.split("\n").length;
  return "Invalid JSON near line " + line + ", column " + (pos - before.lastIndexOf("\n"));
}
function jsonScalar(v) {
  if (v instanceof RawNum || typeof v === "number") return h("span", { class: "j-num", text: jsonCellText(v) });
  if (typeof v === "string") return h("span", { class: "j-str", text: JSON.stringify(v) });
  if (typeof v === "boolean") return h("span", { class: "j-bool", text: String(v) });
  return h("span", { class: "j-null", text: "null" });
}
function jPunc(t) { return h("span", { class: "j-punc", text: t }); }
// Collapsible tree. Children render lazily on expand, in batches of JSON_BATCH ("Show more"); the first two levels
// open automatically while they fit in JSON_AUTO_NODES, so a large document never builds thousands of nodes up front.
function jsonTree(root, download, title) {
  var budget = JSON_AUTO_NODES;
  // key: object key, or null for array items (index/of give "item 3 of 12" for screen readers) and the root.
  function node(key, v, depth, last, index, of) {
    var line = h("div", { class: "j-line" });
    var name = key !== null ? String(key) : index != null ? "item " + (index + 1) + " of " + of : null;
    var label = key === null ? null : [h("span", { class: "j-key", text: JSON.stringify(key) }), jPunc(": ")];
    var comma = last ? null : jPunc(",");
    budget--;
    if (!isJsonContainer(v)) { add(line, [label, jsonScalar(v), comma]); return line; }
    var arr = Array.isArray(v), keys = arr ? null : Object.keys(v), count = arr ? v.length : keys.length;
    var open = arr ? "[" : "{", close = arr ? "]" : "}";
    if (!count) { add(line, [label, jPunc(open + close), comma]); return line; }
    var what = plural(count, arr ? "item" : "key");
    var kids = h("div", { class: "j-kids", role: "group", "aria-label": (name === null ? (arr ? "Array" : "Object") : name) + ", " + what });
    var shut = h("span", { class: "j-more" }, h("span", { class: "j-sum", text: " " + what + " " }), jPunc(close), comma ? jPunc(",") : null);
    var tail = h("div", { class: "j-line" }, jPunc(close), comma);
    var built = false;
    var btn = h("button", { type: "button", class: "j-toggle", "aria-expanded": "false", "aria-label": "Expand " + (name === null ? (arr ? "array" : "object") : name) + " (" + what + ")",
      onclick: function () { setOpen(btn.getAttribute("aria-expanded") !== "true"); } }, icon("chevron"));
    function fill(from) {
      var end = Math.min(count, from + JSON_BATCH);
      for (var i = from; i < end; i++) kids.appendChild(node(arr ? null : keys[i], v[arr ? i : keys[i]], depth + 1, i === count - 1, arr ? i : null, count));
      if (end < count) {
        var more = h("div", { class: "j-line" }, h("button", { type: "button", class: "j-showmore", onclick: function () { more.remove(); fill(end); } },
          "Show " + fmtCount(Math.min(JSON_BATCH, count - end)) + " more (" + fmtCount(count - end) + " not shown)"));
        kids.appendChild(more);
      }
    }
    function setOpen(on) {
      if (on && !built) { built = true; fill(0); }
      btn.setAttribute("aria-expanded", String(on));
      btn.setAttribute("aria-label", (on ? "Collapse " : "Expand ") + (name === null ? (arr ? "array" : "object") : name) + " (" + what + ")");
      kids.hidden = !on; tail.hidden = !on; shut.hidden = on;
    }
    add(line, [btn, label, jPunc(open), shut]);
    var wrap = h("div", { class: "j-node" }, line, kids, tail);
    var auto = depth < 2 && Math.min(count, JSON_BATCH) <= budget;
    if (auto) budget -= Math.min(count, JSON_BATCH);
    setOpen(auto);
    return wrap;
  }
  var top = node(null, root, 0, true);
  var out = [h("div", { class: "json-tree", role: "region", tabIndex: 0, "aria-label": "JSON tree" + (title ? ": " + title : "") }, top)];
  var n = isJsonContainer(root) ? (Array.isArray(root) ? root.length : Object.keys(root).length) : 0;
  if (n > JSON_BATCH) out.push(dataNote("Showing " + fmtCount(JSON_BATCH) + " " + (Array.isArray(root) ? "items" : "keys") + " at a time (" + fmtCount(n) + " in all)", download));
  return out;
}
// Value-level JSON comparison for History: added / removed / changed leaves (and whole subtrees), keyed by a
// JSONPath-like path ($.a.b[2], $["odd key"]). Arrays compare by index. Stops collecting after cap entries but
// keeps counting (total). Walks at most 200,000 nodes; past that it stops and sets incomplete, and callers must not
// present the result as "no changes".
function jsonPath(base, key) {
  if (typeof key === "number") return base + "[" + key + "]";
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? base + "." + key : base + "[" + JSON.stringify(key) + "]";
}
// Exact decimal value of a JSON number's source text: sign, significant digits and a power of ten, without going
// through a double (so 9007199254740992 and 9007199254740993 differ, while 1.0, 1 and 1e0 are the same value).
// Linear in the text (zeros are counted with loops, not regexes). Exponents beyond 15 digits can't be adjusted
// exactly as doubles, so such numbers keep their text and only match identical text (never a false "same").
function jsonDecimal(src) {
  var m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(src);
  if (!m) return src;
  var frac = m[3] || "", e = m[4] || "0", digits = m[2] + frac;
  if (e.replace(/^[-+]/, "").length > 15) return "x" + src;
  var i = 0, j = digits.length;
  while (i < j && digits.charCodeAt(i) === 48) i++;
  if (i === j) return "0";
  while (digits.charCodeAt(j - 1) === 48) j--;
  return m[1] + digits.slice(i, j) + "e" + (Number(e) - frac.length + (digits.length - j));
}
function jsonSame(a, b) {
  if (a instanceof RawNum || b instanceof RawNum) {
    var sa = a instanceof RawNum ? a.src : typeof a === "number" ? String(a) : null, sb = b instanceof RawNum ? b.src : typeof b === "number" ? String(b) : null;
    return sa !== null && sb !== null && (sa === sb || jsonDecimal(sa) === jsonDecimal(sb));
  }
  return a === b;
}
function jsonChanges(a, b, cap) {
  var list = [], total = 0, budget = 200000, incomplete = false;
  function push(op, path, from, to) { total++; if (list.length < cap) list.push({ op: op, path: path, from: from, to: to }); }
  (function walk(x, y, path) {
    if (incomplete || --budget < 0) { incomplete = true; return; }
    var cx = isJsonContainer(x), cy = isJsonContainer(y);
    if (cx && cy && Array.isArray(x) === Array.isArray(y)) {
      if (Array.isArray(x)) {
        for (var i = 0; i < Math.max(x.length, y.length); i++) {
          if (i >= y.length) push("removed", jsonPath(path, i), x[i]);
          else if (i >= x.length) push("added", jsonPath(path, i), undefined, y[i]);
          else walk(x[i], y[i], jsonPath(path, i));
        }
      } else {
        var own = Object.prototype.hasOwnProperty;
        Object.keys(x).forEach(function (k) { if (!own.call(y, k)) push("removed", jsonPath(path, k), x[k]); else walk(x[k], y[k], jsonPath(path, k)); });
        Object.keys(y).forEach(function (k) { if (!own.call(x, k)) push("added", jsonPath(path, k), undefined, y[k]); });
      }
    } else if (cx || cy || !jsonSame(x, y)) push("changed", path, x, y);
  })(a, b, "$");
  return { list: list, total: total, incomplete: incomplete };
}
// One-line, length-capped text for a JSON value (leaves exactly as written; containers summarised).
function jsonBrief(v) {
  if (Array.isArray(v)) return "[" + plural(v.length, "item") + "]";
  if (isJsonContainer(v)) return "{" + plural(Object.keys(v).length, "key") + "}";
  var s = v instanceof RawNum ? v.src : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
}
function jsonSummary(v) {
  if (Array.isArray(v)) return "Array · " + plural(v.length, "item");
  if (isJsonContainer(v)) return "Object · " + plural(Object.keys(v).length, "key");
  return v === null ? "null" : v instanceof RawNum ? "Number" : typeof v === "string" ? "String" : typeof v === "boolean" ? "Boolean" : "Number";
}
function jsonPreview(text, opts) {
  var v;
  try { v = jsonParse(text); } catch (e) { return dataProblem(jsonErrorText(e, text), opts.problemHint); }
  var recs = jsonRecords(v), holder = h("div", { class: "data-view" }), views = {};
  var size = opts.size != null ? " · " + fmtBytes(opts.size) : "";
  var summary = h("p", { class: "data-summary" });
  var bar = h("div", { class: "data-bar" }, summary);
  // Older browsers don't pass number source text to JSON.parse revivers: numbers are then rounded doubles.
  var rounded = !JSON_EXACT_NUMBERS && /\d/.test(text) ? dataNote("Numbers may be rounded in this browser; " + (opts.rawHint || "the Raw tab shows exact values")) : null;
  function show(name) {
    if (!views[name]) views[name] = h("div", null, name === "table"
      ? cappedTable(recs.header, recs.count, recs.row, "JSON records: " + recs.header.slice(0, 3).join(", ") + (recs.header.length > 3 ? ", …" : ""), opts.download)
      : jsonTree(v, opts.download, opts.title));
    holder.replaceChildren(views[name]);
    summary.textContent = (name === "table" ? plural(recs.count, "record") + " · " + plural(recs.header.length, "column") : jsonSummary(v)) + size;
    if (seg) Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute("aria-pressed", String(b.dataset.view === name)); });
  }
  var seg = null;
  if (recs) {
    seg = h("div", { class: "tabs data-views", role: "group", "aria-label": "JSON view" },
      [["tree", "Tree"], ["table", "Table"]].map(function (t) { return h("button", { type: "button", dataset: { view: t[0] }, "aria-pressed": "false", onclick: function () { show(t[0]); } }, t[1]); }));
    bar.append(seg);
  }
  show("tree");
  return h("div", { class: "datafile" }, bar, holder, rounded);
}
// opts: { size (bytes), download (URL for the full file), title (for labels), problemHint (what to do if invalid) }
function dataPreview(kind, text, opts) { return kind === "csv" ? csvPreview(text, opts || {}) : jsonPreview(text, opts || {}); }

function renderDataFile(A, data, ui) {
  var info = h("p", { class: "muted small" });
  var holder = h("div"), actions = h("p", { class: "row data-actions" });
  var raw = h("pre", { class: "raw", tabIndex: 0, role: "region" });
  var text = "";
  async function draw(d) {
    A.rev = d.revision.rev; A.meta = d.artifact;
    var kind = d.artifact.kind, url = d.content_url, name = kind === "csv" ? "CSV" : "JSON";
    text = typeof d.content === "string" ? d.content : await (await offFetchBlob(url)).text();
    info.textContent = name + " · " + fmtBytes(d.revision.size) + " · rev " + d.revision.rev + " · updated " + fmtDate(d.revision.created_at);
    info.title = "sha256 " + d.revision.sha256;
    raw.textContent = text; raw.setAttribute("aria-label", "Raw " + name);
    holder.replaceChildren(dataPreview(kind, text, { size: d.revision.size, download: downloadUrl(url), title: d.artifact.title }));
    // replaceChildren() would print a null argument as the text "null"; pass only real nodes.
    actions.replaceChildren(h("a", { class: "btn secondary", href: downloadUrl(url), download: d.artifact.title || "download" }, icon("download"), "Download"));
    // The spreadsheet-safe export is served only with App Connect on; otherwise the server would ignore the
    // format and return the raw CSV, so the button (and its promise) only appears when the server will honour it.
    if (kind === "csv") dataFilesEnabled(A.pid).then(function (on) {
      if (on !== true || !A.alive || actions.querySelector(".data-why")) return;
      var why = h("span", { class: "muted small data-why", id: "data-why-" + (++tabSeq), text: "Spreadsheet version: cells starting with = + - @ stay text, not formulas." });
      actions.append(h("a", { class: "btn ghost", href: url + (url.indexOf("?") < 0 ? "?" : "&") + "format=spreadsheet", download: "", "aria-describedby": why.id }, icon("download"), "Download for spreadsheets"), why);
    });
  }
  A.reload = async function () {
    try { await draw(await api("GET", A.base)); }
    catch (e) { if (e.status !== 401) holder.replaceChildren(dataProblem("Couldn't reload this file (" + e.message + ")", "Reload the page to try again.")); }
  };
  shell(projCrumbs(A.pid, [{ t: A.meta.title }]), h("div", { class: "titlebar" }, ui.titleEl, copyBar(A, function () { return text; }, offlineToggle(A))), info, ui.tabNav);
  ui.below.append(ui.details);
  ui.addTab("preview", "Preview", null);
  ui.panels.preview.append(holder, actions);
  ui.addTab("raw", "Raw", null);
  ui.panels.raw.append(raw);
  ui.below.prepend(h("details", null, h("summary", { text: "Replace with a new version" }),
    h("p", { class: "muted small", text: "Upload a " + (A.meta.kind === "csv" ? "CSV" : "JSON") + " file (UTF-8, up to 1 MB). The current version stays in History." }),
    uploadForm(A.pid, function () { return { artifact_id: A.aid, expected_revision: A.rev }; }, function () { A.reload(); }, A.meta.kind)));
  draw(data).catch(function (e) { holder.replaceChildren(dataProblem("Couldn't load this file (" + e.message + ")", "Reload the page to try again.")); });
}

function renderMarkdownEditor(A, data, ui) {
  var pid = A.pid, aid = A.aid;
  var D = { savedBody: data.body, saving: false, again: false, attempt: null, conflict: null, timer: null, retryTimer: null, errCount: 0 };
  var statusEl = h("span", { class: "status", role: "status", "aria-live": "polite" });
  var banner = h("div", { class: "banner", hidden: true });
  var isHtml = A.meta.kind === "html";
  var plain = h("textarea", { class: "editor", spellcheck: true, "aria-label": isHtml ? "HTML source" : "Markdown source" });
  plain.value = data.body;
  // "ta" is the active editor: the plain textarea, or the CodeMirror adapter once it has loaded (same surface).
  var ta = plain;
  var edHost = h("div", { class: "ed-host" }, plain);
  var saveBtn = h("button", { type: "button", class: "secondary", title: "Autosaves after you pause typing; unsaved text is kept in this browser", onclick: function () { saveNow(); } }, "Save now");
  var conflictBox = h("div", { class: "card conflict", hidden: true });
  var previewBox = h("div", { class: "preview" });
  var previewNote = h("p", { class: "muted small" });
  // HTML documents render in a sandboxed iframe: no scripts, forms or top navigation (see src/html.ts).
  // allow-same-origin only so its <img>/<video> carry the session; allow-popups so links open in a new tab.
  // NEVER add allow-scripts.
  var frame = isHtml ? h("iframe", { class: "htmlview", title: "Rendered page", sandbox: FRAME_SANDBOX, referrerpolicy: "no-referrer" }) : null;

  function isDirty() { return ta.value !== D.savedBody; }
  // Save now becomes the primary (accent) button whenever there is something to save.
  function setStatus(state, text) {
    statusEl.dataset.state = state; statusEl.textContent = text;
    saveBtn.classList.toggle("secondary", !(state === "dirty" || state === "error"));
  }
  function setSaved() { setStatus("saved", "Saved - rev " + A.rev); }
  function showBanner(t) { banner.textContent = t; banner.hidden = !t; }
  function persistDraft(body) { writeDraft(pid, aid, A.rev, body); }
  A.isBusy = function () { return isDirty() || D.saving || !!D.conflict; };

  function schedule(ms) { clearTimeout(D.timer); D.timer = setTimeout(saveNow, ms); }
  function onInput() {
    if (D.conflict) return;
    persistDraft(ta.value);
    if (!D.saving) setStatus(isDirty() ? "dirty" : "saved", isDirty() ? "Unsaved changes" : "Saved - rev " + A.rev);
    schedule(1200);
  }
  ta.addEventListener("input", onInput);
  // Upgrade to the syntax-highlighting editor (lazy; falls back to the textarea offline or on failure).
  // The swap carries over text, caret, scroll, focus and read-only state, so nothing typed is lost.
  loadEditor().then(function (E) {
    if (!E || !A.alive || ta !== plain) return;
    var cm;
    try { cm = E.mountEditor(edHost, { lang: isHtml ? "html" : "markdown", value: plain.value, label: isHtml ? "HTML source" : "Markdown source" }); }
    catch (e) { return; }
    var sel = plain.selectionStart, top = edTop(plain), wasFocused = document.activeElement === plain;
    if (cm.value !== plain.value) cm.value = plain.value; // typed while loading
    cm.readOnly = plain.readOnly;
    plain.removeEventListener("input", onInput);
    plain.hidden = true;
    ta = cm; activeEd = cm;
    ta.addEventListener("input", onInput);
    try { ta.setSelectionRange(sel, sel); } catch (e) {}
    edScrollTo(ta, top.pos, top.delta);
    if (wasFocused) ta.focus({ preventScroll: true });
    S.cleanups.push(function () { try { cm.destroy(); } catch (e) {} });
  });

  // Serialized autosave: one PUT in flight; the same Idempotency-Key is reused when retrying the same body+base.
  async function saveNow() {
    clearTimeout(D.timer); clearTimeout(D.retryTimer);
    if (D.conflict) return;
    if (D.saving) { D.again = true; return; }
    if (!isDirty()) { clearDraft(pid, aid); setSaved(); return; }
    var body = ta.value, baseRev = A.rev;
    if (!D.attempt || D.attempt.body !== body || D.attempt.base !== baseRev) D.attempt = { body: body, base: baseRev, key: uuid() };
    var att = D.attempt;
    D.saving = true; D.again = false; setStatus("saving", "Saving...");
    try {
      var r = await api("PUT", A.base, { expected_revision: att.base, body: att.body }, { key: att.key });
      A.rev = r.revision; D.savedBody = att.body; D.attempt = null; D.errCount = 0;
      showBanner("");
    } catch (err) {
      D.saving = false;
      if (err.status === 409 && err.code === "revision_conflict") { D.attempt = null; enterConflict((err.data.error || {}).current_revision); return; }
      if (err.status === 401) return; // draft already persisted per keystroke under this principal's key
      if (err.status === 422) D.attempt = null;
      D.errCount++;
      var retry = err.status === 0 || err.status >= 500 || err.status === 429;
      setStatus("error", "Save failed: " + err.message + (retry ? " - retrying" : ""));
      persistDraft(ta.value);
      if (retry && A.alive) D.retryTimer = setTimeout(saveNow, Math.min(30000, 2000 * Math.pow(2, D.errCount - 1)));
      return;
    }
    D.saving = false;
    if (isDirty()) { persistDraft(ta.value); setStatus("dirty", "Unsaved changes"); schedule(D.again ? 300 : 800); }
    else { clearDraft(pid, aid); setSaved(); }
    D.again = false;
    if (A.tab === "preview") loadPreview();
  }
  A.flush = function () { if (isDirty() && !D.conflict) return saveNow(); };

  // Conflict view: keeps local text, never auto-merges.
  async function enterConflict(currentRev, note) {
    D.conflict = { latestRev: currentRev, latest: null };
    ta.readOnly = true;
    persistDraft(ta.value);
    setStatus("conflict", "Conflict - not saved");
    var mine = h("textarea", { class: "half", id: "conflict-mine", "aria-label": "Your text (not saved, editable)", "aria-describedby": "conflict-desc" }); mine.value = ta.value;
    mine.addEventListener("input", function () { ta.value = mine.value; persistDraft(mine.value); });
    var theirs = h("textarea", { class: "half", id: "conflict-theirs", readOnly: true, "aria-label": "Latest saved text on the server (read-only)" });
    var latestHdr = h("strong", { text: "Latest on server" });
    var cmsg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
    async function fetchLatest() {
      try { var r = await api("GET", A.base); D.conflict.latestRev = r.revision.rev; D.conflict.latest = r.body; theirs.value = r.body; latestHdr.textContent = "Latest on server (rev " + r.revision.rev + ")"; A.meta = r.artifact; }
      catch (err) { showErr(cmsg, err); }
    }
    conflictBox.setAttribute("role", "region"); conflictBox.setAttribute("aria-labelledby", "conflict-title");
    conflictBox.replaceChildren(
      h("h2", { id: "conflict-title", text: "Not saved: this document changed elsewhere" }),
      h("p", { id: "conflict-desc", text: note || ("Someone saved a newer revision (rev " + (currentRev || "?") + ") after you started editing rev " + A.rev + ". Your text has NOT been saved and is kept below. Nothing is merged automatically.") }),
      h("div", { class: "cols" }, h("div", null, h("label", { for: "conflict-mine", class: "col-label" }, h("strong", { text: "Your text (editable, kept in this browser)" })), mine), h("div", null, h("label", { for: "conflict-theirs", class: "col-label" }, latestHdr), theirs)),
      h("div", { class: "row" },
        h("button", { type: "button", class: "secondary", onclick: function () { mine.select(); copyText(mine.value, cmsg); } }, "Copy my text"),
        h("button", { type: "button", class: "secondary", onclick: function () {
          if (D.conflict.latest === null) return;
          if (!confirm("Discard your text and load the latest server revision?")) return;
          exitConflict(D.conflict.latest, D.conflict.latestRev);
        } }, "Load latest (discard mine)"),
        h("button", { type: "button", onclick: async function (e) {
          if (D.conflict.latest === null) { await fetchLatest(); }
          if (!confirm("Save your text as a new revision on top of rev " + D.conflict.latestRev + "?")) return;
          e.target.disabled = true;
          var body = mine.value;
          try {
            var r = await api("PUT", A.base, { expected_revision: D.conflict.latestRev, body: body }, { key: uuid() });
            exitConflict(body, r.revision);
          } catch (err) {
            if (err.status === 409) { showMsg(cmsg, "The server changed again; latest text reloaded. Review and retry."); await fetchLatest(); }
            else showErr(cmsg, err);
          }
          e.target.disabled = false;
        } }, "Save mine over latest")),
      cmsg);
    conflictBox.hidden = false;
    ui.showTab("edit");
    conflictBox.scrollIntoView({ block: "nearest" });
    // Move focus into the conflict only if the user was editing (don't steal focus from elsewhere on restore).
    if (edFocused(ta) || document.activeElement === document.body) { try { mine.focus({ preventScroll: true }); } catch (e) {} }
    await fetchLatest();
  }
  function exitConflict(body, rev) {
    D.conflict = null; conflictBox.hidden = true; conflictBox.replaceChildren();
    A.rev = rev; D.savedBody = body; ta.value = body; ta.readOnly = false;
    clearDraft(pid, aid); showBanner(""); setSaved(); ui.fillMeta();
  }

  // Clean-view refresh on focus/visibility + 10s poll; never replaces a dirty draft.
  async function refresh() {
    if (!A.alive || document.hidden || D.saving || D.conflict) return;
    var r;
    try { r = await api("GET", A.base); } catch (err) { if (err.status === 404) showBanner("This artifact is no longer available (trashed or removed)."); return; }
    if (!A.alive || D.saving || D.conflict) return;
    A.meta = r.artifact; ui.fillMeta();
    if (r.revision.rev > A.rev) {
      if (isDirty()) showBanner("A newer revision (rev " + r.revision.rev + ") exists on the server. Your edits are kept; saving will open the conflict view.");
      else {
        A.rev = r.revision.rev; D.savedBody = r.body; replaceEditorText(ta, r.body); setSaved(); if (A.tab === "preview") loadPreview();
        showBanner("Updated to rev " + r.revision.rev + " (changed elsewhere). Your place was kept.");
        clearTimeout(D.noteTimer); D.noteTimer = setTimeout(function () { if (A.alive && !D.conflict && !isDirty()) showBanner(""); }, 6000);
      }
    }
  }
  A.reload = async function () {
    var r = await api("GET", A.base);
    A.meta = r.artifact; A.rev = r.revision.rev; D.savedBody = r.body; ta.value = r.body; clearDraft(pid, aid); setSaved(); ui.fillMeta();
  };
  var poll = setInterval(refresh, 10000);
  var onFocus = function () { refresh(); };
  var onVis = function () { if (!document.hidden) refresh(); };
  var onUnload = function (e) { if (isDirty() || D.saving) { persistDraft(ta.value); e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("beforeunload", onUnload);
  S.cleanups.push(function (discard) {
    clearInterval(poll); clearTimeout(D.timer); clearTimeout(D.retryTimer);
    window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("beforeunload", onUnload);
    if (!discard && isDirty() && !D.conflict && !D.saving) { persistDraft(ta.value); saveNow(); }
  });

  async function loadPreview() {
    previewNote.textContent = (isDirty() ? "Showing saved rev " + A.rev + " (unsaved edits are not included)." : "");
    previewNote.hidden = !previewNote.textContent;
    if (isHtml) {
      // The response carries CSP script-src 'none' + sandbox, and the iframe sandbox has no allow-scripts.
      var src = A.base + "/render?rev=" + A.rev;
      if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
      return;
    }
    try {
      var r = await api("GET", A.base + "/preview?rev=" + A.rev); previewBox.innerHTML = r.html; enhanceTables(previewBox);
      previewBox.querySelectorAll("video[data-artifact]").forEach(function (v) { v.preload = "metadata"; });
      previewBox.querySelectorAll("img[data-artifact]").forEach(function (im) {
        im.tabIndex = 0; im.title = "View full size";
        var open = function () { openLightbox(im.getAttribute("src"), im.getAttribute("alt") || "image"); };
        im.addEventListener("click", open);
        im.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      });
    }
    catch (err) { previewBox.replaceChildren(h("p", { class: "msg", role: "alert", text: "Preview failed: " + err.message })); }
  }

  var docMeta = h("p", { class: "doc-meta", text: (isHtml ? "Page" : "Doc") + " · " + (projectTitles[pid] || pid) + " · updated " + fmtDate(A.meta.updated_at) });
  var templateNote = A.meta.is_template ? h("p", { class: "template-note" }, h("span", { class: "badge", text: "Template" }), " Edits affect future copies only.") : null;
  var sourceNote = h("p", { class: "muted small", hidden: !A.meta.source });
  A.templateSourceNote = sourceNote;
  shell(projCrumbs(pid, [{ t: A.meta.title }]), h("div", { class: "titlebar" }, ui.titleEl, copyBar(A, function () { return ta.value; }, offlineToggle(A))), docMeta, templateNote, sourceNote, banner, conflictBox, ui.tabNav);
  // Save status/button and Details sit below the document; the status stays announced (aria-live).
  ui.below.append(h("div", { class: "footbar" }, statusEl, h("span", { class: "spacer" }), saveBtn), ui.details);
  ui.fillMeta();
  ui.addTab("preview", isHtml ? "Page" : "Preview", loadPreview);
  ui.panels.preview.append(previewNote, isHtml ? frame : previewBox);
  ui.addTab("edit", "Edit", function () { if (ta.view) ta.view.requestMeasure(); });
  ui.panels.edit.append(edHost);
  setSaved();

  // Recover a local draft for this principal/project/artifact.
  var dr = readDraft(pid, aid);
  if (dr && typeof dr.body === "string" && dr.body !== data.body) {
    ta.value = dr.body;
    if (dr.base === A.rev) { setStatus("dirty", "Unsaved changes"); showBanner("Restored your unsaved local draft from " + fmtDate(dr.at) + "."); schedule(800); }
    else enterConflict(A.rev, "Your unsaved local draft was based on rev " + dr.base + ", but the server is now at rev " + A.rev + ". Your draft is kept below; choose how to proceed.");
  } else if (dr) clearDraft(pid, aid);
}

// ---------- offline copies (owner-chosen; IndexedDB; read-only; wiped on sign-out) ----------
// Stored UNENCRYPTED in this browser profile (owner decision; encryption is a later step). Only items the
// owner explicitly marks, or items in projects the owner marks "keep offline". Bounded by a configurable cap.
var OFF = (function () {
  var dbp = null;
  function open() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var r = indexedDB.open("al-offline", 1);
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore("items", { keyPath: "key" }); d.createObjectStore("projects", { keyPath: "pid" }); d.createObjectStore("meta", { keyPath: "k" }); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then(function (d) { return new Promise(function (res, rej) {
      var t = d.transaction(store, mode), out = fn(t.objectStore(store));
      t.oncomplete = function () { res(out && typeof out.readyState === "string" ? out.result : out); };
      t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
    }); });
  }
  return {
    get: function (s, k) { return tx(s, "readonly", function (o) { return o.get(k); }); },
    all: function (s) { return tx(s, "readonly", function (o) { return o.getAll(); }); },
    put: function (s, v) { return tx(s, "readwrite", function (o) { o.put(v); }); },
    del: function (s, k) { return tx(s, "readwrite", function (o) { o.delete(k); }); },
    clear: function () { return Promise.all(["items", "projects", "meta"].map(function (s) { return tx(s, "readwrite", function (o) { o.clear(); }); })).catch(function () {}); },
  };
})();
var OFF_CAP_KEY = "al:offline:capMB", OFF_CAP_DEFAULT = 200, OFF_CAP_CHOICES = [50, 100, 200, 500, 1000, 2000];
function offCapMB() { var v = Number(localStorage.getItem(OFF_CAP_KEY)); return v > 0 ? v : OFF_CAP_DEFAULT; }
function offCapBytes() { return Math.round(offCapMB() * 1048576); }
function offKey(pid, aid) { return pid + "/" + aid; }
// Expiry (TTL): offline copies not opened for N days are removed from this device only (never from the library).
var OFF_TTL_KEY = "al:offline:ttlDays", OFF_TTL_DEFAULT = 30, OFF_TTL_CHOICES = [0, 1, 7, 14, 30, 90];
function offTtlDays() { var v = localStorage.getItem(OFF_TTL_KEY); if (v === null) return OFF_TTL_DEFAULT; v = Number(v); return v >= 0 ? v : OFF_TTL_DEFAULT; }
function offTtlLabel(d) { return d === 0 ? "Never" : d === 1 ? "1 day" : d + " days"; }
function offLastUsed(x) { return x.last_used || x.saved_at || x.added_at || 0; }
function offExpiresIn(x) { var d = offTtlDays(); if (!d) return null; return offLastUsed(x) + d * 86400000 - Date.now(); }
function offExpiryText(x, keptByProject) {
  if (keptByProject) return "kept with project";
  var ms = offExpiresIn(x); if (ms === null) return "no expiry";
  var days = Math.ceil(ms / 86400000);
  return days <= 0 ? "expires now" : days === 1 ? "expires in 1 day" : "expires in " + days + " days";
}
// Opening an item (online or offline) resets its timer and its project's timer.
async function offTouch(pid, aid) {
  try {
    var now = Date.now();
    if (aid) { var it = await OFF.get("items", offKey(pid, aid)); if (it) { it.last_used = now; await OFF.put("items", it); } }
    var p = await OFF.get("projects", pid); if (p) { p.last_used = now; await OFF.put("projects", p); }
  } catch (e) {}
}
// Remove expired copies from this device. Items belonging to a project that is still kept offline stay; a kept
// project expires when nothing in it has been opened for the TTL. Never touches the library itself.
async function offSweep() {
  var days = offTtlDays(), out = { items: 0, projects: 0 };
  if (!days) return out;
  var cutoff = Date.now() - days * 86400000;
  try {
    var projects = await OFF.all("projects"), kept = {};
    for (var i = 0; i < projects.length; i++) {
      if (offLastUsed(projects[i]) < cutoff) { await OFF.del("projects", projects[i].pid); out.projects++; } else kept[projects[i].pid] = true;
    }
    var items = await OFF.all("items");
    for (var j = 0; j < items.length; j++) {
      if (!kept[items[j].pid] && offLastUsed(items[j]) < cutoff) { await OFF.del("items", items[j].key); out.items++; }
    }
    if (out.items || out.projects) await OFF.put("meta", { k: "swept", at: Date.now(), removed: out });
  } catch (e) {}
  return out;
}
function utf8Len(s) { return s ? new Blob([s]).size : 0; }
async function offUsage() { var items = await OFF.all("items"); return items.reduce(function (n, it) { return n + (it.size || 0); }, 0); }
async function offFetchBlob(url) {
  var r;
  try { r = await fetch(url, { credentials: "same-origin", cache: "no-store" }); } catch (e) { throw new ApiError(0, { error: { code: "network", message: "Network error" } }); }
  if (!r.ok || r.redirected) throw new ApiError(r.status || 0, { error: { code: "fetch_failed", message: "Could not download the file (HTTP " + r.status + ")" } });
  return r.blob();
}
// Owner binding: copies belong to the principal that saved them; anyone else signing in wipes them.
async function offCheckOwner(principalId) {
  try { var o = await OFF.get("meta", "owner"); if (o && o.id !== principalId) await OFF.clear(); } catch (e) {}
}
async function offSave(pid, aid) {
  var base = "/api/projects/" + enc(pid) + "/artifacts/" + enc(aid);
  var d = await api("GET", base, undefined, { noAuthRedirect: true });
  var it = { key: offKey(pid, aid), pid: pid, aid: aid, title: d.artifact.title, kind: d.artifact.kind, mime: d.revision.mime,
    rev: d.revision.rev, updated_at: d.artifact.updated_at, saved_at: Date.now(), project_title: projectTitles[pid] || pid, size: 0 };
  if (d.artifact.kind === "markdown") {
    it.body = d.body;
    var pv = await api("GET", base + "/preview?rev=" + d.revision.rev, undefined, { noAuthRedirect: true });
    it.html = pv.html; it.images = {};
    var doc = new DOMParser().parseFromString(pv.html, "text/html");
    var srcs = Array.from(doc.querySelectorAll("img[data-artifact]")).map(function (im) { return im.getAttribute("src"); })
      .filter(function (s, i, a) { return s && s.charAt(0) === "/" && a.indexOf(s) === i; });
    for (var i = 0; i < srcs.length; i++) { try { it.images[srcs[i]] = await offFetchBlob(srcs[i]); } catch (e) {} }
    it.size = utf8Len(it.body) + utf8Len(it.html) + Object.keys(it.images).reduce(function (n, k) { return n + it.images[k].size; }, 0);
  } else if (d.artifact.kind === "html") {
    // The server-sanitized rendered page (no scripts); shown offline in a sandboxed iframe via srcdoc.
    it.body = d.body;
    var rp = await fetch(base + "/render?rev=" + d.revision.rev, { credentials: "same-origin", cache: "no-store" });
    if (!rp.ok) throw new Error("Could not save the rendered page (" + rp.status + ")");
    it.page = await rp.text();
    it.size = utf8Len(it.body) + utf8Len(it.page);
  } else if (isDataKind(d.artifact.kind)) {
    // CSV / JSON: the text itself; the offline viewer renders the same preview from it.
    it.body = typeof d.content === "string" ? d.content : await (await offFetchBlob(d.content_url)).text();
    it.size = utf8Len(it.body);
  } else {
    it.blob = await offFetchBlob(d.content_url);
    it.size = it.blob.size;
  }
  var items = await OFF.all("items");
  var prev = items.filter(function (x) { return x.key === it.key; })[0];
  it.last_used = prev ? offLastUsed(prev) : Date.now(); // background refresh never extends the expiry timer
  var used = items.reduce(function (n, x) { return n + (x.key === it.key ? 0 : (x.size || 0)); }, 0);
  if (used + it.size > offCapBytes()) {
    var err = new Error("Offline storage limit reached (" + fmtBytes(offCapBytes()) + "). Remove items or raise the limit in Settings → Offline.");
    err.code = "offline_cap"; throw err;
  }
  await OFF.put("items", it);
  if (S.me) await OFF.put("meta", { k: "owner", id: S.me.id });
  if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
  return it;
}
async function offListAll(pid) {
  var out = [], cursor = null, guard = 0;
  do {
    var r = await api("GET", "/api/projects/" + enc(pid) + "/artifacts" + (cursor ? "?cursor=" + enc(cursor) : ""), undefined, { noAuthRedirect: true });
    out = out.concat(r.artifacts); cursor = r.next_cursor;
  } while (cursor && ++guard < 40);
  return out;
}
// Keep every item in a project offline: save new or changed items; stops (and reports) at the storage cap.
async function offSyncProject(pid, stats) {
  stats = stats || { added: 0, updated: 0, removed: 0, failed: 0, capped: false };
  var have = {}; (await OFF.all("items")).forEach(function (x) { if (x.pid === pid) have[x.aid] = x; });
  var list = await offListAll(pid);
  for (var i = 0; i < list.length; i++) {
    var a = list[i], ex = have[a.id];
    if (ex && ex.rev === a.revision && ex.title === a.title) continue;
    try { await offSave(pid, a.id); if (ex) stats.updated++; else stats.added++; }
    catch (e) { if (e.code === "offline_cap") { stats.capped = true; break; } stats.failed++; }
  }
  return stats;
}
var offRefreshing = null;
// Bring saved copies up to date (each app open while online, and on demand). Items the owner can no longer
// read (trashed, removed, access lost) are deleted from this device.
function offRefreshAll() {
  if (offRefreshing) return offRefreshing;
  offRefreshing = (async function () {
    var stats = { added: 0, updated: 0, removed: 0, failed: 0, capped: false };
    if (!S.me || S.offline) return stats;
    var items = await OFF.all("items");
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      try {
        var d = await api("GET", "/api/projects/" + enc(it.pid) + "/artifacts/" + enc(it.aid), undefined, { noAuthRedirect: true });
        if (d.revision.rev !== it.rev || d.artifact.title !== it.title) { await offSave(it.pid, it.aid); stats.updated++; }
      } catch (e) {
        if (e.status === 404 || e.status === 403) { await OFF.del("items", it.key); stats.removed++; }
        else if (e.code === "offline_cap") stats.capped = true;
        else if (e.status === 0 || e.status === 401) break;
        else stats.failed++;
      }
    }
    var projects = await OFF.all("projects");
    for (var j = 0; j < projects.length && !stats.capped; j++) {
      try { await offSyncProject(projects[j].pid, stats); }
      catch (e) { if (e.status === 404 || e.status === 403) await OFF.del("projects", projects[j].pid); else if (e.status === 0 || e.status === 401) break; else stats.failed++; }
    }
    await OFF.put("meta", { k: "refreshed", at: Date.now(), stats: stats });
    return stats;
  })().finally(function () { offRefreshing = null; });
  return offRefreshing;
}
// Title-bar toggle on a document/file page.
function offlineToggle(A) {
  var b = iconButton("offline", "Make available offline", null);
  var on = false;
  function paint() {
    b.classList.toggle("done", on);
    var t = on ? "Available offline (tap to remove from this device)" : "Make available offline";
    b.title = t; b.setAttribute("aria-label", t); b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  OFF.get("items", offKey(A.pid, A.aid)).then(function (it) { on = !!it; paint(); }).catch(function () {});
  b.addEventListener("click", async function () {
    b.disabled = true;
    try {
      if (on) { await OFF.del("items", offKey(A.pid, A.aid)); on = false; toast("Removed from this device"); }
      else { toast("Saving for offline…"); await offSave(A.pid, A.aid); on = true; toast("Available offline"); }
    } catch (e) { toast(e.code === "offline_cap" ? "Offline storage is full (" + fmtBytes(offCapBytes()) + ")" : "Couldn't save offline: " + e.message); }
    b.disabled = false; paint();
  });
  paint();
  return b;
}

// ---------- offline mode views (no network: read saved copies only) ----------
function offlineBanner() {
  return h("p", { class: "banner offline-banner" }, "Offline: showing copies saved on this device (read-only). ",
    h("a", { href: "#", onclick: function (e) { e.preventDefault(); location.reload(); } }, "Try again"));
}
function offAge(t) { return t ? "saved " + fmtDate(t) : ""; }
async function viewOfflineHome() {
  var list = h("ul", { class: "list" });
  shell([{ t: "Offline" }], offlineBanner(), h("div", { class: "titlebar" }, h("h1", { text: "Saved on this device" })), list);
  var items = []; try { items = await OFF.all("items"); } catch (e) {}
  if (!items.length) { list.append(h("li", { class: "empty", text: "Nothing is saved for offline use on this device." })); return; }
  items.sort(function (a, b) { return (a.project_title || "").localeCompare(b.project_title || "") || (a.title || "").localeCompare(b.title || ""); });
  var kept = {}; try { (await OFF.all("projects")).forEach(function (p) { kept[p.pid] = true; }); } catch (e) {}
  var last = null;
  items.forEach(function (it) {
    if (it.pid !== last) { last = it.pid; list.append(h("li", { class: "group", text: it.project_title || it.pid })); }
    var href = "#/p/" + enc(it.pid) + "/a/" + enc(it.aid);
    list.append(h("li", { class: "link", onclick: function (e) { if (e.target.tagName !== "A") location.hash = href; } },
      h("div", { class: "grow" }, h("a", { href: href, text: it.title }), h("small", { class: "muted", text: "rev " + it.rev + " · " + fmtBytes(it.size) + " · " + offAge(it.saved_at) + " · " + offExpiryText(it, !!kept[it.pid]) })),
      h("span", { class: "badge", text: kindLabel(it) })));
  });
  resumeApply("list");
}
async function viewOfflineItem(pid, aid, tab) {
  var it = null; try { it = await OFF.get("items", offKey(pid, aid)); } catch (e) {}
  if (it) offTouch(pid, aid);
  if (!it) {
    shell([{ t: "Offline", href: "#/" }], offlineBanner(), h("div", { class: "card" }, h("h1", { text: "Not available offline" }),
      h("p", { class: "muted", text: "This item isn't saved on this device. Connect to the internet to open it." }),
      h("a", { class: "btn secondary", href: "#/" }, "Saved items")));
    return;
  }
  var urls = [];
  S.cleanups.push(function () { urls.forEach(function (u) { URL.revokeObjectURL(u); }); });
  function blobUrl(b) { var u = URL.createObjectURL(b); urls.push(u); return u; }
  var info = h("p", { class: "muted small", text: "Saved copy · rev " + it.rev + " · " + offAge(it.saved_at) + " · " + fmtBytes(it.size) });
  var body = h("div");
  if (it.kind === "markdown") {
    var pv = h("div", { class: "preview" }); pv.innerHTML = it.html || ""; enhanceTables(pv); // server-sanitized HTML saved while online
    pv.querySelectorAll("img").forEach(function (im) {
      var src = im.getAttribute("src"), b = it.images && it.images[src];
      if (b) { var u = blobUrl(b); im.src = u; im.tabIndex = 0; im.addEventListener("click", function () { openLightbox(u, im.alt || "image"); }); }
      else { im.replaceWith(h("span", { class: "muted small", text: "[image not saved offline]" })); }
    });
    var raw = h("pre", { class: "raw", text: it.body || "" });
    var tabs = tabList("Saved copy views");
    var sel = tab === "raw" ? "raw" : "preview";
    [["preview", "Preview", pv], ["raw", "Text", raw]].forEach(function (t) {
      var b = tabButton(t[1], t[2], function () { selectTab(tabs, b); pv.hidden = t[0] !== "preview"; raw.hidden = t[0] !== "raw"; });
      tabs.append(b); if (t[0] === sel) selectTab(tabs, b);
    });
    pv.hidden = sel !== "preview"; raw.hidden = sel !== "raw";
    body.append(tabs, pv, raw);
  } else if (it.kind === "html") {
    // No scripts, opaque origin (links still open in a new tab); the stored page was sanitized by the server. Media need the network.
    var fr = h("iframe", { class: "htmlview", title: "Rendered page (saved copy)", sandbox: "allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer" });
    fr.srcdoc = it.page || "";
    var rawH = h("pre", { class: "raw", text: it.body || "", hidden: true });
    var tabsH = tabList("Saved page views");
    [["page", "Page", fr], ["raw", "Source", rawH]].forEach(function (t) {
      var b = tabButton(t[1], t[2], function () { selectTab(tabsH, b); fr.hidden = t[0] !== "page"; rawH.hidden = t[0] !== "raw"; });
      tabsH.append(b); if (t[0] === "page") selectTab(tabsH, b);
    });
    body.append(tabsH, h("p", { class: "muted small", text: "Images and videos in pages need a connection." }), fr, rawH);
  } else if (isDataKind(it.kind)) {
    // Copies saved before data previews existed hold a blob instead of text.
    var dtext = typeof it.body === "string" ? it.body : it.blob ? await it.blob.text() : "";
    it.body = dtext;
    var du = blobUrl(new Blob([dtext], { type: it.mime || "text/plain" }));
    var dpv = dataPreview(it.kind, dtext, { size: utf8Len(dtext), download: du });
    var drawRaw = h("pre", { class: "raw", tabIndex: 0, text: dtext, "aria-label": "Raw " + (it.kind === "csv" ? "CSV" : "JSON") });
    var tabsD = tabList("Saved copy views"), dsel = tab === "raw" ? "raw" : "preview";
    [["preview", "Preview", dpv], ["raw", "Raw", drawRaw]].forEach(function (t) {
      var b = tabButton(t[1], t[2], function () { selectTab(tabsD, b); dpv.hidden = t[0] !== "preview"; drawRaw.hidden = t[0] !== "raw"; });
      tabsD.append(b); if (t[0] === dsel) selectTab(tabsD, b);
    });
    dpv.hidden = dsel !== "preview"; drawRaw.hidden = dsel !== "raw";
    body.append(tabsD, dpv, drawRaw, h("p", { class: "row" }, h("a", { class: "btn secondary", href: du, download: it.title || "file" }, icon("download"), "Save to device")));
  } else {
    var u = blobUrl(it.blob), dl = h("a", { class: "btn secondary", href: u, download: it.title || "file" }, icon("download"), "Save to device");
    if (/^image\/(png|jpeg|webp|gif)$/.test(it.mime)) body.append(h("div", { class: "media" }, h("img", { src: u, alt: it.title, tabIndex: 0, onclick: function () { openLightbox(u, it.title); } }), h("p", { class: "row" }, dl)));
    else if (it.mime === "video/mp4" || it.mime === "video/webm") body.append(h("div", { class: "media" }, h("video", { src: u, controls: true, playsInline: true }), h("p", { class: "row" }, dl)));
    else body.append(h("div", { class: "filecard" }, h("span", { class: "ficon" }, icon("file")),
      h("div", { class: "grow" }, h("strong", { text: it.title }), h("div", { class: "muted small", text: (it.mime === "application/pdf" ? "PDF document" : it.mime) + " · opens in your device's viewer" })),
      h("a", { class: "btn", href: u, download: it.title || "document.pdf" }, icon("external"), "Open")));
  }
  shell([{ t: "Offline", href: "#/" }, { t: it.project_title || pid }], offlineBanner(),
    h("div", { class: "titlebar" }, h("h1", { text: it.title }), isTextDoc(it.kind) || isDataKind(it.kind) ? copyIcon("copy", "Copy contents", function () { return it.body || ""; }) : null), info, body);
  resumeApply("artifact");
}
function offlineRoute() {
  var p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (p[0] === "p" && p[1] && p[2] === "a" && p[3]) return viewOfflineItem(p[1], p[3], p[4] === "preview" ? "preview" : null);
  if (p[0] === "settings" && p[1] === "publishing") return viewPublishingApps();
  if (p[0] === "settings" && p[1] === "device") return viewDevice();
  return viewOfflineHome();
}

// ---------- settings: this device (offline storage) ----------
async function viewDevice() {
  var msg = h("p", { class: "msg", role: "status" });
  var usage = h("p", { class: "muted" }), bar = h("div", { class: "meter" }, h("span"));
  var capSel = h("select", { "aria-label": "Offline storage limit" }, OFF_CAP_CHOICES.map(function (mb) {
    return h("option", { value: String(mb), selected: mb === offCapMB(), text: mb >= 1000 ? (mb / 1000) + " GB" : mb + " MB" });
  }));
  if (OFF_CAP_CHOICES.indexOf(offCapMB()) < 0) capSel.prepend(h("option", { value: String(offCapMB()), selected: true, text: offCapMB() + " MB" }));
  var ttlSel = h("select", { "aria-label": "Remove offline copies not opened for" }, OFF_TTL_CHOICES.map(function (d) {
    return h("option", { value: String(d), selected: d === offTtlDays(), text: offTtlLabel(d) });
  }));
  if (OFF_TTL_CHOICES.indexOf(offTtlDays()) < 0) ttlSel.prepend(h("option", { value: String(offTtlDays()), selected: true, text: offTtlLabel(offTtlDays()) }));
  var projList = h("ul", { class: "list" }), itemList = h("ul", { class: "list" });
  var refreshBtn = h("button", { type: "button", class: "secondary", disabled: !!S.offline }, "Refresh now");
  var wipeBtn = h("button", { type: "button", class: "danger" }, "Remove all from this device");
  async function draw() {
    var items = [], projects = [], meta = null;
    try { items = await OFF.all("items"); projects = await OFF.all("projects"); meta = await OFF.get("meta", "refreshed"); } catch (e) { showErr(msg, e); }
    var used = items.reduce(function (n, x) { return n + (x.size || 0); }, 0), cap = offCapBytes();
    usage.textContent = fmtBytes(used) + " of " + fmtBytes(cap) + " used · " + items.length + " item" + (items.length === 1 ? "" : "s") + (meta ? " · last refreshed " + fmtDate(meta.at) : "");
    bar.firstChild.style.width = Math.min(100, Math.round(used * 100 / cap)) + "%";
    bar.classList.toggle("warn", used > cap * 0.9);
    projList.replaceChildren();
    if (!projects.length) projList.append(h("li", { class: "empty", text: "No whole projects kept offline. Use “Keep offline” on a project page." }));
    var keptPids = {}; projects.forEach(function (p) { keptPids[p.pid] = true; });
    projects.forEach(function (p) {
      projList.append(h("li", null, h("div", { class: "grow" }, h("span", { text: p.title || p.pid }), h("small", { class: "muted", text: "last opened " + fmtDate(offLastUsed(p)) + " · " + offExpiryText(p, false) })),
        h("button", { type: "button", class: "secondary", onclick: async function () { await OFF.del("projects", p.pid); showMsg(msg, "“" + (p.title || p.pid) + "” is no longer kept offline. Its saved items stay until you remove them or they expire.", true); draw(); } }, "Stop keeping offline")));
    });
    itemList.replaceChildren();
    if (!items.length) itemList.append(h("li", { class: "empty", text: "Nothing saved on this device." }));
    items.sort(function (a, b) { return (b.size || 0) - (a.size || 0); }).forEach(function (it) {
      itemList.append(h("li", null, h("div", { class: "grow" }, h("a", { href: "#/p/" + enc(it.pid) + "/a/" + enc(it.aid), text: it.title }),
        h("small", { class: "muted", text: (it.project_title || it.pid) + " · " + fmtBytes(it.size) + " · rev " + it.rev + " · " + offAge(it.saved_at) + " · " + offExpiryText(it, !!keptPids[it.pid]) })),
        iconButton("trash", "Remove from this device", async function () { await OFF.del("items", it.key); draw(); })));
    });
  }
  capSel.addEventListener("change", function () { localStorage.setItem(OFF_CAP_KEY, capSel.value); showMsg(msg, "Limit set to " + capSel.options[capSel.selectedIndex].text + ". New saves stop at the limit; nothing already saved is removed.", true); draw(); });
  ttlSel.addEventListener("change", async function () {
    localStorage.setItem(OFF_TTL_KEY, ttlSel.value);
    var r = await offSweep();
    showMsg(msg, (Number(ttlSel.value) ? "Copies not opened for " + offTtlLabel(Number(ttlSel.value)) + " are removed from this device (never from the library)." : "Offline copies no longer expire.")
      + (r.items || r.projects ? " Removed " + r.items + " expired item" + (r.items === 1 ? "" : "s") + (r.projects ? " and " + r.projects + " project" + (r.projects === 1 ? "" : "s") : "") + " now." : ""), true);
    draw();
  });
  refreshBtn.addEventListener("click", async function () {
    refreshBtn.disabled = true; showMsg(msg, "Refreshing…", true);
    try { var st = await offRefreshAll(); showMsg(msg, "Up to date: " + st.updated + " updated, " + st.added + " added, " + st.removed + " removed" + (st.failed ? ", " + st.failed + " failed" : "") + (st.capped ? ". Storage limit reached; some items were not saved." : "."), !st.capped && !st.failed); }
    catch (e) { showErr(msg, e); }
    refreshBtn.disabled = false; draw();
  });
  wipeBtn.addEventListener("click", async function () {
    if (!confirm("Remove every offline copy from this device?")) return;
    await OFF.clear(); showMsg(msg, "Removed everything from this device.", true); draw();
  });
  shell(S.offline ? [{ t: "Offline", href: "#/" }, { t: "This device" }] : [{ t: "Settings" }],
    S.offline ? offlineBanner() : null,
    S.offline ? h("h1", { text: "Offline on this device" }) : pageHead("Settings", { sub: "Preferences for this browser. Your library's apps and keys are managed under Connections." }),
    S.offline ? null : h("h2", { text: "Offline on this device" }),
    h("p", { class: "muted small", text: "Saved copies are read-only, stored unencrypted in this browser, and removed when you sign out. Anyone who can unlock this device and open the app can read them. They refresh when the app opens online, and expire automatically if not opened (setting below)." }),
    h("div", { class: "card" }, usage, bar, h("label", { class: "setting" }, h("span", { class: "grow", text: "Storage limit" }), capSel),
      h("label", { class: "setting" }, h("span", { class: "grow" }, h("span", { text: "Remove copies not opened for" }), h("small", { class: "muted", text: "From this device only. The library keeps everything." })), ttlSel),
      h("div", { class: "row" }, refreshBtn, wipeBtn), msg),
    h("h2", { text: "Projects kept offline" }), projList,
    h("h2", { text: "Saved items" }), itemList);
  draw();
}


// ---------- caret/scroll anchoring across document changes ----------
// Re-finds a position in new text using short snippets of the old text around it (no full text stored).
// Order: exact same context -> text before -> text after -> same line number -> clamp to the end.
var ANCHOR_LEN = 40;
function caretAnchor(text, pos) {
  pos = Math.max(0, Math.min(pos || 0, text.length));
  return { pos: pos, before: text.slice(Math.max(0, pos - ANCHOR_LEN), pos), after: text.slice(pos, pos + ANCHOR_LEN),
    line: text.slice(0, pos).split("\n").length - 1, len: text.length };
}
function nearestIndex(text, needle, near) {
  if (!needle) return -1;
  var best = -1, bestD = Infinity, i = text.indexOf(needle);
  for (var n = 0; i >= 0 && n < 200; n++) { var d = Math.abs(i - near); if (d < bestD) { best = i; bestD = d; } i = text.indexOf(needle, i + 1); }
  return best;
}
function caretResolve(text, a) {
  if (!a) return 0;
  if (a.len === text.length && text.slice(Math.max(0, a.pos - a.before.length), a.pos) === a.before && text.slice(a.pos, a.pos + a.after.length) === a.after) return a.pos;
  var i = nearestIndex(text, a.before + a.after, a.pos - a.before.length);
  if (i >= 0) return i + a.before.length;
  // Shrink the snippets (edits may touch the very edge of the context).
  for (var k = a.before.length; k >= 8; k = Math.floor(k / 2)) {
    i = nearestIndex(text, a.before.slice(-k), a.pos - k); if (i >= 0) return i + k;
  }
  for (k = a.after.length; k >= 8; k = Math.floor(k / 2)) {
    i = nearestIndex(text, a.after.slice(0, k), a.pos); if (i >= 0) return i;
  }
  // Same line number, else clamp.
  var lines = text.split("\n");
  if (a.line < lines.length) { var off = 0; for (var L = 0; L < a.line; L++) off += lines[L].length + 1; return off; }
  return text.length;
}
// Replace the editor text while keeping the caret and the visible line anchored to the same content.
// Works with the plain textarea or the CodeMirror adapter (same textarea-like surface; see editor/editor.js).
function edFocused(ta) { return ta.isFocused ? ta.isFocused() : document.activeElement === ta; }
function edTop(ta) {
  if (ta.topAnchor) return ta.topAnchor();
  var lh = parseFloat(getComputedStyle(ta).lineHeight) || 20, tl = Math.floor(ta.scrollTop / lh), off = 0, ls = ta.value.split("\n");
  for (var L = 0; L < Math.min(tl, ls.length); L++) off += ls[L].length + 1;
  return { pos: off, delta: ta.scrollTop - tl * lh };
}
function edScrollTo(ta, pos, delta) {
  if (ta.scrollToPos) return ta.scrollToPos(pos, delta);
  var lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, ta.value.slice(0, pos).split("\n").length - 1) * lh + (delta || 0);
}
function replaceEditorText(ta, text) {
  var focused = edFocused(ta);
  var caret = caretAnchor(ta.value, ta.selectionStart);
  var top = edTop(ta);
  var view = caretAnchor(ta.value, top.pos);
  ta.value = text;
  var c = caretResolve(text, caret);
  try { ta.setSelectionRange(c, c); } catch (e) {}
  edScrollTo(ta, caretResolve(text, view), top.delta);
  if (focused) { try { ta.focus({ preventScroll: true }); } catch (e) {} }
}

// ---------- resume where you left off (Android may discard a backgrounded app; the installed app then reloads
// at its start URL). Saved per signed-in user in localStorage: route, tab, window scroll, editor scroll+caret,
// project search. Besides ids and positions it keeps two short context snippets (<= 40 chars each side of the
// caret and of the top visible line) to re-find the place if the document changed. Cleared on sign-out. ----------
var RESUME_KEY = "al:resume", RESUME_MAX_AGE = 7 * 86400000;
var resumePending = null; // state to apply once the restored view has rendered
function resumeKey() { return RESUME_KEY + ":" + (S.me ? S.me.id : "offline"); }
function resumeSave() {
  try {
    var st = { at: Date.now(), hash: location.hash || "#/", y: Math.round(window.scrollY) };
    var ta = activeEditor();
    if (ta) {
      st.edTop = ta.scrollTop; st.edSel = ta.selectionStart; st.edFocus = edFocused(ta);
      // Short context snippets (not the document) so the caret/scroll can be re-found if the text changed.
      st.edCaret = caretAnchor(ta.value, ta.selectionStart);
      var top = edTop(ta);
      st.edView = caretAnchor(ta.value, top.pos); st.edDelta = top.delta;
    }
    var tab = document.querySelector("main .tabs [role=tab][aria-selected=true]");
    if (tab) st.tab = tab.textContent;
    var q = document.querySelector('main .toolbar input[type=search]');
    if (q && q.value) st.q = q.value;
    localStorage.setItem(resumeKey(), JSON.stringify(st));
  } catch (e) {}
}
function resumeLoad() {
  try { var st = JSON.parse(localStorage.getItem(resumeKey()) || "null"); if (st && Date.now() - st.at < RESUME_MAX_AGE) return st; } catch (e) {}
  return null;
}
function resumeClear() { try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf(RESUME_KEY) === 0) localStorage.removeItem(k); } } catch (e) {} }
var resumeTimer = null;
function resumeSoon() { clearTimeout(resumeTimer); resumeTimer = setTimeout(resumeSave, 250); }
// Called by views when their content is in place; applies saved scroll/tab/editor state once.
function resumeApply(kind) {
  var st = resumePending; if (!st || st.hash !== (location.hash || "#/")) return;
  if (kind === "artifact" && st.tab) {
    var b = Array.from(document.querySelectorAll("main .tabs [role=tab]")).filter(function (x) { return x.textContent === st.tab; })[0];
    if (b && b.getAttribute("aria-selected") !== "true") b.click();
  }
  var ta = activeEditor();
  if (ta && st.edTop != null) {
    if (st.edCaret && st.edView) {
      var c = caretResolve(ta.value, st.edCaret), v = caretResolve(ta.value, st.edView);
      try { ta.setSelectionRange(c, c); } catch (e) {}
      edScrollTo(ta, v, st.edDelta || 0);
    } else {
      ta.scrollTop = st.edTop;
      if (st.edSel != null) { try { ta.setSelectionRange(st.edSel, st.edSel); } catch (e) {} }
    }
    if (st.edFocus) { try { ta.focus({ preventScroll: true }); } catch (e) {} }
  }
  // Scroll after layout settles (lists and previews load asynchronously).
  var tries = 0;
  (function scroll() {
    window.scrollTo(0, st.y || 0);
    if (Math.abs(window.scrollY - (st.y || 0)) > 4 && ++tries < 20) setTimeout(scroll, 100);
  })();
  resumePending = null;
}
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") resumeSave(); });
window.addEventListener("pagehide", resumeSave);
window.addEventListener("scroll", resumeSoon, { passive: true });
document.addEventListener("scroll", function (e) { if (e.target && e.target.classList && (e.target.classList.contains("editor") || e.target.classList.contains("cm-scroller"))) resumeSoon(); }, true);
document.addEventListener("selectionchange", function () { var a = document.activeElement; if (a && a.classList && (a.classList.contains("editor") || a.classList.contains("cm-content"))) resumeSoon(); });
window.addEventListener("hashchange", resumeSoon);
document.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("nav.tabs")) resumeSoon(); }, true);

// ---------- boot ----------
window.addEventListener("hashchange", route);
// Installable app (PWA): register the network-only service worker (it caches nothing). Registration is async
// and failure is harmless (the site works the same without it).
if ("serviceWorker" in navigator && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
  window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {}); });
}
// Installed app launches with ?source=pwa; drop it so links and reloads stay clean.
// "Bare" = the installed app's start URL (or the site root) with no in-app route at all; "#/" is an explicit link.
var launchedBare = (location.pathname === "/" || location.pathname === "/index.html") && (!location.hash || location.hash === "#");
if (/[?&]source=pwa\b/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
// Canonical deep links are paths (/p/:pid[/a/:aid], see src/links.ts) so they survive sign-in redirects.
// Map them onto the in-app hash route before anything else (login included) so the destination is kept.
(function adoptPathRoute() {
  var m = /^\/p\/([^/]+)(?:\/a\/([^/]+)(?:\/(preview|edit))?)?\/?$/.exec(location.pathname);
  if (!m) return;
  history.replaceState(null, "", "/#/p/" + m[1] + (m[2] ? "/a/" + m[2] + (m[3] ? "/" + m[3] : "") : ""));
})();
(async function boot() {
  try {
    var me;
    try { me = await api("GET", "/api/me", undefined, { noAuthRedirect: true }); }
    catch (e1) {
      // Hosted: exchange the verified Cloudflare Access identity for an app session (no passphrase).
      if (e1.status !== 401 || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) throw e1;
      await api("POST", "/auth/access-login", {}, { noAuthRedirect: true });
      me = await api("GET", "/api/me", undefined, { noAuthRedirect: true });
    }
    S.me = me.principal; S.csrf = me.csrf;
    if (S.me.kind !== "human") { S.me = null; return viewLogin("Bearer-token principals cannot use the browser app."); }
    purgeForeignDrafts(S.me.id);
    await offCheckOwner(S.me.id);
    await offSweep();
  } catch (e) {
    S.me = null;
    // No network (or Access sign-in page unreachable): open saved offline copies instead of a dead login form.
    if (e && e.status === 0) {
      await offSweep();
      var saved = []; try { saved = await OFF.all("items"); } catch (e2) {}
      if (saved.length || !navigator.onLine) S.offline = true;
    }
  }
  // Resume: an explicit link wins; a bare launch (installed app start, reload after Android discarded it)
  // returns to the last place this user was. A reload of the same URL also restores scroll/tab/editor.
  var st = resumeLoad();
  if (st && (S.me || S.offline)) {
    if (launchedBare && st.hash && st.hash !== "#/") history.replaceState(null, "", "/" + st.hash);
    if (st.hash === (location.hash || "#/")) resumePending = st;
  }
  route();
  if (S.me) setTimeout(function () { offRefreshAll().catch(function () {}); }, 1500);
})();
})();
