  // File types (src/file-types). One group per list item, in the order the Type sort uses.
  var TYPES = ["doc", "page", "image", "video", "pdf", "csv", "json", "file"];
  function typeOf(a) {
    if (!a) return "file";
    if (a.kind === "markdown") return "doc";
    if (a.kind === "html") return "page";
    if (a.kind === "csv" || a.kind === "json") return a.kind;
    var m = typeof a.mime === "string" ? a.mime.toLowerCase() : "";
    if (m.indexOf("image/") === 0) return "image";
    if (m.indexOf("video/") === 0) return "video";
    if (m === "application/pdf") return "pdf";
    return "file";
  }
