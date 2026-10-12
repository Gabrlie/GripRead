// Runs once in every source script context, before the source's jsLib.
// It gives scripts the Rhino/Java surface Legado sources are written
// against; the natives live in `__native` and are implemented in Rust.
(function (global) {
  "use strict";
  var native = global.__native;
  delete global.__native;

  function hide(target, name, value) {
    Object.defineProperty(target, name, {
      value: value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  // Java List methods on arrays, as Rhino exposes Java lists.
  hide(Array.prototype, "size", function () {
    return this.length;
  });
  hide(Array.prototype, "get", function (index) {
    return this[index];
  });
  hide(Array.prototype, "isEmpty", function () {
    return this.length === 0;
  });
  hide(Array.prototype, "toArray", function () {
    return Array.prototype.slice.call(this);
  });
  hide(Array.prototype, "add", function (item) {
    this.push(item);
    return true;
  });
  hide(Array.prototype, "contains", function (item) {
    return this.indexOf(item) !== -1;
  });

  // java.lang.String methods JavaScript strings lack.
  hide(String.prototype, "equals", function (other) {
    return String(this) === String(other);
  });
  hide(String.prototype, "equalsIgnoreCase", function (other) {
    return String(this).toLowerCase() === String(other).toLowerCase();
  });
  hide(String.prototype, "isEmpty", function () {
    return this.length === 0;
  });
  hide(String.prototype, "contains", function (other) {
    return String(this).indexOf(String(other)) !== -1;
  });
  hide(String.prototype, "matches", function (pattern) {
    return native.javaMatches(String(this), String(pattern));
  });
  hide(String.prototype, "getBytes", function (charset) {
    return native.strToBytes(String(this), charset || "UTF-8");
  });

  // JSON.parse accepts values that are already parsed, and the lenient JSON
  // GSON reads.
  var parseJson = JSON.parse;
  JSON.parse = function (text, reviver) {
    if (typeof text !== "string") {
      if (text !== null && typeof text === "object") return text;
      text = String(text);
    }
    try {
      return parseJson(text, reviver);
    } catch (error) {
      var lenient = native.lenientJson(text);
      if (lenient === undefined) throw error;
      return parseJson(lenient, reviver);
    }
  };

  // Jsoup elements, backed by handles into the Rust document.
  var ElementProto = {};
  var ElementsProto = Object.create(Array.prototype);

  function element(handle) {
    if (handle === null || handle === undefined || handle < 0) return null;
    var item = Object.create(ElementProto);
    hide(item, "__h", handle);
    return item;
  }
  function elements(handles) {
    var list = handles.map(element);
    Object.setPrototypeOf(list, ElementsProto);
    return list;
  }
  hide(global, "__gr_element", element);
  hide(global, "__gr_elements", elements);

  var methods = {
    select: function (css) {
      return elements(native.elSelect(this.__h, String(css)));
    },
    selectFirst: function (css) {
      var found = native.elSelect(this.__h, String(css));
      return found.length ? element(found[0]) : null;
    },
    text: function () {
      return native.elText(this.__h);
    },
    ownText: function () {
      return native.elOwnText(this.__h);
    },
    wholeText: function () {
      return native.elText(this.__h);
    },
    html: function () {
      return native.elHtml(this.__h);
    },
    outerHtml: function () {
      return native.elOuterHtml(this.__h);
    },
    data: function () {
      return native.elData(this.__h);
    },
    attr: function (name) {
      return native.elAttr(this.__h, String(name));
    },
    absUrl: function (name) {
      return native.elAttr(this.__h, "abs:" + String(name));
    },
    hasAttr: function (name) {
      return native.elHasAttr(this.__h, String(name));
    },
    attributes: function () {
      return native.elAttrs(this.__h);
    },
    tagName: function () {
      return native.elTag(this.__h);
    },
    nodeName: function () {
      return native.elTag(this.__h);
    },
    id: function () {
      return native.elAttr(this.__h, "id");
    },
    className: function () {
      return native.elAttr(this.__h, "class");
    },
    hasClass: function (name) {
      return native.elHasClass(this.__h, String(name));
    },
    children: function () {
      return elements(native.elChildren(this.__h));
    },
    child: function (index) {
      return element(native.elChildren(this.__h)[index]);
    },
    parent: function () {
      return element(native.elParent(this.__h));
    },
    nextElementSibling: function () {
      return element(native.elNext(this.__h));
    },
    previousElementSibling: function () {
      return element(native.elPrev(this.__h));
    },
    getElementsByTag: function (name) {
      return elements(native.elByTag(this.__h, String(name)));
    },
    getElementsByClass: function (name) {
      return elements(native.elByClass(this.__h, String(name)));
    },
    getElementById: function (id) {
      var found = native.elById(this.__h, String(id));
      return found.length ? element(found[0]) : null;
    },
    textNodes: function () {
      return native.elTextNodes(this.__h);
    },
    toString: function () {
      return native.elOuterHtml(this.__h);
    },
    toJSON: function () {
      return native.elOuterHtml(this.__h);
    },
  };
  Object.keys(methods).forEach(function (name) {
    hide(ElementProto, name, methods[name]);
  });

  var listMethods = {
    text: function () {
      return this.map(function (item) {
        return item.text();
      })
        .filter(function (text) {
          return text.length > 0;
        })
        .join(" ");
    },
    eachText: function () {
      return this.map(function (item) {
        return item.text();
      }).filter(function (text) {
        return text.length > 0;
      });
    },
    attr: function (name) {
      for (var i = 0; i < this.length; i++) {
        if (this[i].hasAttr(name)) return this[i].attr(name);
      }
      return "";
    },
    eachAttr: function (name) {
      return this.filter(function (item) {
        return item.hasAttr(name);
      }).map(function (item) {
        return item.attr(name);
      });
    },
    hasAttr: function (name) {
      return this.some(function (item) {
        return item.hasAttr(name);
      });
    },
    html: function () {
      return this.map(function (item) {
        return item.html();
      }).join("\n");
    },
    outerHtml: function () {
      return this.map(function (item) {
        return item.outerHtml();
      }).join("\n");
    },
    select: function (css) {
      var found = [];
      this.forEach(function (item) {
        native.elSelect(item.__h, String(css)).forEach(function (handle) {
          if (found.indexOf(handle) === -1) found.push(handle);
        });
      });
      return elements(found);
    },
    first: function () {
      return this.length ? this[0] : null;
    },
    last: function () {
      return this.length ? this[this.length - 1] : null;
    },
    eq: function (index) {
      return elements(this[index] ? [this[index].__h] : []);
    },
    toString: function () {
      return this.outerHtml();
    },
    toJSON: function () {
      return this.map(function (item) {
        return item.outerHtml();
      });
    },
  };
  Object.keys(listMethods).forEach(function (name) {
    hide(ElementsProto, name, listMethods[name]);
  });

  // Book, chapter, and response objects. Fields are snapshots; the host
  // writes changed fields back after the script.
  hide(global, "__gr_book", function (book) {
    hide(book, "getVariable", function (key) {
      return native.bookGetVar(key === undefined ? null : String(key));
    });
    hide(book, "putVariable", function (key, value) {
      native.bookPutVar(String(key), value === undefined || value === null ? null : String(value));
      return true;
    });
    hide(book, "getCustomVariable", function () {
      return native.bookGetVar("custom");
    });
    hide(book, "putCustomVariable", function (value) {
      native.bookPutVar("custom", String(value));
    });
    hide(book, "getName", function () {
      return book.name;
    });
    hide(book, "getAuthor", function () {
      return book.author;
    });
    hide(book, "getBookUrl", function () {
      return book.bookUrl;
    });
    hide(book, "getTocUrl", function () {
      return book.tocUrl;
    });
    return book;
  });
  hide(global, "__gr_chapter", function (chapter) {
    hide(chapter, "getVariable", function (key) {
      return native.chapterGetVar(key === undefined ? null : String(key));
    });
    hide(chapter, "putVariable", function (key, value) {
      native.chapterPutVar(String(key), value === undefined || value === null ? null : String(value));
      return true;
    });
    hide(chapter, "getTitle", function () {
      return chapter.title;
    });
    hide(chapter, "getUrl", function () {
      return chapter.url;
    });
    return chapter;
  });
  hide(global, "__gr_response", function (data) {
    var response = {};
    hide(response, "__body", data.body);
    hide(response, "__data", data);
    var methods = {
      body: function () {
        return data.body;
      },
      url: function () {
        return data.url;
      },
      code: function () {
        return data.code;
      },
      statusCode: function () {
        return data.code;
      },
      message: function () {
        return data.message;
      },
      statusMessage: function () {
        return data.message;
      },
      headers: function () {
        return data.headers;
      },
      header: function (name) {
        var wanted = String(name).toLowerCase();
        for (var key in data.headers) {
          if (key.toLowerCase() === wanted) return data.headers[key];
        }
        return null;
      },
      cookies: function () {
        return data.cookies;
      },
      callTime: function () {
        return data.callTime;
      },
      raw: function () {
        return response;
      },
      toString: function () {
        return data.body;
      },
    };
    Object.keys(methods).forEach(function (name) {
      hide(response, name, methods[name]);
    });
    return response;
  });

  // A few Java classes sources reach through Packages and JavaImporter.
  function unsupported(path) {
    return new Proxy(function () {}, {
      get: function (target, name) {
        if (name === Symbol.toPrimitive) {
          return function () {
            return "[JavaPackage " + path + "]";
          };
        }
        if (typeof name === "symbol") return undefined;
        return unsupported(path + "." + String(name));
      },
      apply: function () {
        throw new Error("不支持: " + path);
      },
      construct: function () {
        throw new Error("不支持: " + path);
      },
    });
  }
  function pkg(path, members) {
    return new Proxy(members, {
      get: function (target, name) {
        if (typeof name === "symbol" || name in target) return target[name];
        return unsupported(path + "." + String(name));
      },
    });
  }

  function JavaString(value, charset) {
    var text = Array.isArray(value)
      ? native.bytesToStr(value, charset || "UTF-8")
      : String(value === undefined ? "" : value);
    // `new java.lang.String(...)` must give an object, or `new` drops it.
    return new.target ? new String(text) : text;
  }
  JavaString.valueOf = function (value) {
    return String(value);
  };
  JavaString.format = function (format) {
    var args = Array.prototype.slice.call(arguments, 1);
    var index = 0;
    return String(format).replace(/%(\d+\$)?[-#+ 0,(]*\d*(\.\d+)?[sdfx%]/g, function (token) {
      if (token === "%%") return "%";
      var value = args[index++];
      if (/f$/.test(token)) {
        var precision = /\.(\d+)/.exec(token);
        return Number(value).toFixed(precision ? Number(precision[1]) : 6);
      }
      if (/d$/.test(token)) return String(Math.trunc(Number(value)));
      if (/x$/.test(token)) return Number(value).toString(16);
      return String(value);
    });
  };

  var base64 = {
    NO_WRAP: 2,
    DEFAULT: 0,
    URL_SAFE: 8,
    NO_PADDING: 1,
    decode: function (text, flags) {
      return native.base64DecodeBytes(String(text), flags || 0);
    },
    encodeToString: function (bytes, flags) {
      return native.base64EncodeBytes(typeof bytes === "string" ? native.strToBytes(bytes, "UTF-8") : bytes, flags || 0);
    },
    encode: function (bytes, flags) {
      return native.strToBytes(base64.encodeToString(bytes, flags), "UTF-8");
    },
  };

  function SimpleDateFormat(pattern) {
    this.pattern = String(pattern);
  }
  SimpleDateFormat.prototype.format = function (date) {
    var time = date instanceof Date ? date.getTime() : Number(date);
    return native.timeFormatPattern(time, this.pattern);
  };

  var javaPackage = pkg("java", {
    lang: pkg("java.lang", {
      String: JavaString,
      Integer: {
        parseInt: function (text, radix) {
          return parseInt(text, radix || 10);
        },
        valueOf: function (text) {
          return parseInt(text, 10);
        },
        toString: function (value, radix) {
          return Number(value).toString(radix || 10);
        },
        MAX_VALUE: 2147483647,
      },
      Long: {
        parseLong: function (text) {
          return parseInt(text, 10);
        },
        valueOf: function (text) {
          return parseInt(text, 10);
        },
      },
      Double: {
        parseDouble: function (text) {
          return parseFloat(text);
        },
      },
      Math: Math,
      System: {
        currentTimeMillis: function () {
          return Date.now();
        },
        nanoTime: function () {
          return Date.now() * 1000000;
        },
      },
      StringBuilder: function (initial) {
        var parts = initial === undefined ? [] : [String(initial)];
        this.append = function (value) {
          parts.push(String(value));
          return this;
        };
        this.toString = function () {
          return parts.join("");
        };
        this.length = function () {
          return parts.join("").length;
        };
      },
    }),
    net: pkg("java.net", {
      URLEncoder: {
        encode: function (text, charset) {
          return native.urlEncode(String(text), charset || "UTF-8");
        },
      },
      URLDecoder: {
        decode: function (text, charset) {
          return native.urlDecode(String(text), charset || "UTF-8");
        },
      },
    }),
    util: pkg("java.util", {
      UUID: {
        randomUUID: function () {
          var id = native.randomUUID();
          return {
            toString: function () {
              return id;
            },
          };
        },
      },
      Base64: {
        getDecoder: function () {
          return {
            decode: function (text) {
              return native.base64DecodeBytes(typeof text === "string" ? text : native.bytesToStr(text, "UTF-8"), 0);
            },
          };
        },
        getEncoder: function () {
          return {
            encodeToString: function (bytes) {
              return native.base64EncodeBytes(bytes, 2);
            },
          };
        },
      },
      Date: Date,
      HashMap: Map,
      ArrayList: Array,
    }),
    text: pkg("java.text", { SimpleDateFormat: SimpleDateFormat }),
  });

  var jsoup = {
    parse: function (html) {
      return element(native.jsoupParse(String(html)));
    },
  };

  var packages = pkg("Packages", {
    java: javaPackage,
    android: pkg("android", {
      util: pkg("android.util", { Base64: base64 }),
      text: pkg("android.text", {
        TextUtils: {
          isEmpty: function (text) {
            return text === null || text === undefined || String(text).length === 0;
          },
          join: function (separator, items) {
            return Array.prototype.join.call(items, separator);
          },
        },
      }),
    }),
    org: pkg("org", { jsoup: pkg("org.jsoup", { Jsoup: jsoup }) }),
    javax: unsupported("javax"),
    cn: unsupported("cn"),
  });
  hide(global, "Packages", packages);
  hide(global, "org", packages.org);
  hide(global, "android", packages.android);

  hide(global, "JavaImporter", function () {
    var scope = {};
    for (var i = 0; i < arguments.length; i++) {
      var source = arguments[i];
      if (source && typeof source === "object") {
        Object.keys(source).forEach(function (name) {
          scope[name] = source[name];
        });
      }
    }
    return scope;
  });

})(globalThis);

// Runs a source script with Legado's bindings as locals, returning the
// completion value Rhino would give. Direct eval keeps each script's
// declarations to itself; this function is sloppy so `with` works.
Object.defineProperty(globalThis, "__gr_eval", {
  value: function (java, source, book, chapter, result, src, baseUrl, title, nextChapterUrl, key, page, cookie, cache, __code) {
    return eval(__code);
  },
  enumerable: false,
});
