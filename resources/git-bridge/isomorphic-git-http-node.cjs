"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// Local/临时/test_isogit_bundle/node_modules/simple-concat/index.js
var require_simple_concat = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/simple-concat/index.js"(exports2, module2) {
    module2.exports = function(stream, cb) {
      var chunks = [];
      stream.on("data", function(chunk) {
        chunks.push(chunk);
      });
      stream.once("end", function() {
        if (cb) cb(null, Buffer.concat(chunks));
        cb = null;
      });
      stream.once("error", function(err) {
        if (cb) cb(err);
        cb = null;
      });
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/mimic-response/index.js
var require_mimic_response = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/mimic-response/index.js"(exports2, module2) {
    "use strict";
    var knownProperties = [
      "aborted",
      "complete",
      "headers",
      "httpVersion",
      "httpVersionMinor",
      "httpVersionMajor",
      "method",
      "rawHeaders",
      "rawTrailers",
      "setTimeout",
      "socket",
      "statusCode",
      "statusMessage",
      "trailers",
      "url"
    ];
    module2.exports = (fromStream, toStream) => {
      if (toStream._readableState.autoDestroy) {
        throw new Error("The second stream must have the `autoDestroy` option set to `false`");
      }
      const fromProperties = new Set(Object.keys(fromStream).concat(knownProperties));
      const properties = {};
      for (const property of fromProperties) {
        if (property in toStream) {
          continue;
        }
        properties[property] = {
          get() {
            const value = fromStream[property];
            const isFunction = typeof value === "function";
            return isFunction ? value.bind(fromStream) : value;
          },
          set(value) {
            fromStream[property] = value;
          },
          enumerable: true,
          configurable: false
        };
      }
      Object.defineProperties(toStream, properties);
      fromStream.once("aborted", () => {
        toStream.destroy();
        toStream.emit("aborted");
      });
      fromStream.once("close", () => {
        if (fromStream.complete) {
          if (toStream.readable) {
            toStream.once("end", () => {
              toStream.emit("close");
            });
          } else {
            toStream.emit("close");
          }
        } else {
          toStream.emit("close");
        }
      });
      return toStream;
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/decompress-response/index.js
var require_decompress_response = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/decompress-response/index.js"(exports2, module2) {
    "use strict";
    var { Transform, PassThrough } = require("stream");
    var zlib = require("zlib");
    var mimicResponse = require_mimic_response();
    module2.exports = (response) => {
      const contentEncoding = (response.headers["content-encoding"] || "").toLowerCase();
      if (!["gzip", "deflate", "br"].includes(contentEncoding)) {
        return response;
      }
      const isBrotli = contentEncoding === "br";
      if (isBrotli && typeof zlib.createBrotliDecompress !== "function") {
        response.destroy(new Error("Brotli is not supported on Node.js < 12"));
        return response;
      }
      let isEmpty = true;
      const checker = new Transform({
        transform(data, _encoding, callback) {
          isEmpty = false;
          callback(null, data);
        },
        flush(callback) {
          callback();
        }
      });
      const finalStream = new PassThrough({
        autoDestroy: false,
        destroy(error, callback) {
          response.destroy();
          callback(error);
        }
      });
      const decompressStream = isBrotli ? zlib.createBrotliDecompress() : zlib.createUnzip();
      decompressStream.once("error", (error) => {
        if (isEmpty && !response.readable) {
          finalStream.end();
          return;
        }
        finalStream.destroy(error);
      });
      mimicResponse(response, finalStream);
      response.pipe(checker).pipe(decompressStream).pipe(finalStream);
      return finalStream;
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/wrappy/wrappy.js
var require_wrappy = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/wrappy/wrappy.js"(exports2, module2) {
    module2.exports = wrappy;
    function wrappy(fn, cb) {
      if (fn && cb) return wrappy(fn)(cb);
      if (typeof fn !== "function")
        throw new TypeError("need wrapper function");
      Object.keys(fn).forEach(function(k) {
        wrapper[k] = fn[k];
      });
      return wrapper;
      function wrapper() {
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; i++) {
          args[i] = arguments[i];
        }
        var ret = fn.apply(this, args);
        var cb2 = args[args.length - 1];
        if (typeof ret === "function" && ret !== cb2) {
          Object.keys(cb2).forEach(function(k) {
            ret[k] = cb2[k];
          });
        }
        return ret;
      }
    }
  }
});

// Local/临时/test_isogit_bundle/node_modules/once/once.js
var require_once = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/once/once.js"(exports2, module2) {
    var wrappy = require_wrappy();
    module2.exports = wrappy(once);
    module2.exports.strict = wrappy(onceStrict);
    once.proto = once(function() {
      Object.defineProperty(Function.prototype, "once", {
        value: function() {
          return once(this);
        },
        configurable: true
      });
      Object.defineProperty(Function.prototype, "onceStrict", {
        value: function() {
          return onceStrict(this);
        },
        configurable: true
      });
    });
    function once(fn) {
      var f = function() {
        if (f.called) return f.value;
        f.called = true;
        return f.value = fn.apply(this, arguments);
      };
      f.called = false;
      return f;
    }
    function onceStrict(fn) {
      var f = function() {
        if (f.called)
          throw new Error(f.onceError);
        f.called = true;
        return f.value = fn.apply(this, arguments);
      };
      var name = fn.name || "Function wrapped with `once`";
      f.onceError = name + " shouldn't be called more than once";
      f.called = false;
      return f;
    }
  }
});

// Local/临时/test_isogit_bundle/node_modules/simple-get/index.js
var require_simple_get = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/simple-get/index.js"(exports2, module2) {
    module2.exports = simpleGet;
    var concat = require_simple_concat();
    var decompressResponse = require_decompress_response();
    var http = require("http");
    var https = require("https");
    var once = require_once();
    var querystring = require("querystring");
    var url = require("url");
    var isStream = (o) => o !== null && typeof o === "object" && typeof o.pipe === "function";
    function simpleGet(opts, cb) {
      opts = Object.assign({ maxRedirects: 10 }, typeof opts === "string" ? { url: opts } : opts);
      cb = once(cb);
      if (opts.url) {
        const { hostname, port, protocol: protocol2, auth, path } = url.parse(opts.url);
        delete opts.url;
        if (!hostname && !port && !protocol2 && !auth) opts.path = path;
        else Object.assign(opts, { hostname, port, protocol: protocol2, auth, path });
      }
      const headers = { "accept-encoding": "gzip, deflate" };
      if (opts.headers) Object.keys(opts.headers).forEach((k) => headers[k.toLowerCase()] = opts.headers[k]);
      opts.headers = headers;
      let body;
      if (opts.body) {
        body = opts.json && !isStream(opts.body) ? JSON.stringify(opts.body) : opts.body;
      } else if (opts.form) {
        body = typeof opts.form === "string" ? opts.form : querystring.stringify(opts.form);
        opts.headers["content-type"] = "application/x-www-form-urlencoded";
      }
      if (body) {
        if (!opts.method) opts.method = "POST";
        if (!isStream(body)) opts.headers["content-length"] = Buffer.byteLength(body);
        if (opts.json && !opts.form) opts.headers["content-type"] = "application/json";
      }
      delete opts.body;
      delete opts.form;
      if (opts.json) opts.headers.accept = "application/json";
      if (opts.method) opts.method = opts.method.toUpperCase();
      const originalHost = opts.hostname;
      const protocol = opts.protocol === "https:" ? https : http;
      const req = protocol.request(opts, (res) => {
        if (opts.followRedirects !== false && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          opts.url = res.headers.location;
          delete opts.headers.host;
          res.resume();
          const redirectHost = url.parse(opts.url).hostname;
          if (redirectHost !== null && redirectHost !== originalHost) {
            delete opts.headers.cookie;
            delete opts.headers.authorization;
          }
          if (opts.method === "POST" && [301, 302].includes(res.statusCode)) {
            opts.method = "GET";
            delete opts.headers["content-length"];
            delete opts.headers["content-type"];
          }
          if (opts.maxRedirects-- === 0) return cb(new Error("too many redirects"));
          else return simpleGet(opts, cb);
        }
        const tryUnzip = typeof decompressResponse === "function" && opts.method !== "HEAD";
        cb(null, tryUnzip ? decompressResponse(res) : res);
      });
      req.on("timeout", () => {
        req.abort();
        cb(new Error("Request timed out"));
      });
      req.on("error", cb);
      if (isStream(body)) body.on("error", cb).pipe(req);
      else req.end(body);
      return req;
    }
    simpleGet.concat = (opts, cb) => {
      return simpleGet(opts, (err, res) => {
        if (err) return cb(err);
        concat(res, (err2, data) => {
          if (err2) return cb(err2);
          if (opts.json) {
            try {
              data = JSON.parse(data.toString());
            } catch (err3) {
              return cb(err3, res, data);
            }
          }
          cb(null, res, data);
        });
      });
    };
    ["get", "post", "put", "patch", "head", "delete"].forEach((method) => {
      simpleGet[method] = (opts, cb) => {
        if (typeof opts === "string") opts = { url: opts };
        return simpleGet(Object.assign({ method: method.toUpperCase() }, opts), cb);
      };
    });
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/primordials.js
var require_primordials = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/primordials.js"(exports2, module2) {
    "use strict";
    var AggregateError = class extends Error {
      constructor(errors) {
        if (!Array.isArray(errors)) {
          throw new TypeError(`Expected input to be an Array, got ${typeof errors}`);
        }
        let message = "";
        for (let i = 0; i < errors.length; i++) {
          message += `    ${errors[i].stack}
`;
        }
        super(message);
        this.name = "AggregateError";
        this.errors = errors;
      }
    };
    module2.exports = {
      AggregateError,
      ArrayIsArray(self) {
        return Array.isArray(self);
      },
      ArrayPrototypeIncludes(self, el) {
        return self.includes(el);
      },
      ArrayPrototypeIndexOf(self, el) {
        return self.indexOf(el);
      },
      ArrayPrototypeJoin(self, sep) {
        return self.join(sep);
      },
      ArrayPrototypeMap(self, fn) {
        return self.map(fn);
      },
      ArrayPrototypePop(self, el) {
        return self.pop(el);
      },
      ArrayPrototypePush(self, el) {
        return self.push(el);
      },
      ArrayPrototypeSlice(self, start, end) {
        return self.slice(start, end);
      },
      Error,
      FunctionPrototypeCall(fn, thisArgs, ...args) {
        return fn.call(thisArgs, ...args);
      },
      FunctionPrototypeSymbolHasInstance(self, instance) {
        return Function.prototype[Symbol.hasInstance].call(self, instance);
      },
      MathFloor: Math.floor,
      Number,
      NumberIsInteger: Number.isInteger,
      NumberIsNaN: Number.isNaN,
      NumberMAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      NumberMIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      NumberParseInt: Number.parseInt,
      ObjectDefineProperties(self, props) {
        return Object.defineProperties(self, props);
      },
      ObjectDefineProperty(self, name, prop) {
        return Object.defineProperty(self, name, prop);
      },
      ObjectGetOwnPropertyDescriptor(self, name) {
        return Object.getOwnPropertyDescriptor(self, name);
      },
      ObjectKeys(obj) {
        return Object.keys(obj);
      },
      ObjectSetPrototypeOf(target, proto) {
        return Object.setPrototypeOf(target, proto);
      },
      Promise,
      PromisePrototypeCatch(self, fn) {
        return self.catch(fn);
      },
      PromisePrototypeThen(self, thenFn, catchFn) {
        return self.then(thenFn, catchFn);
      },
      PromiseReject(err) {
        return Promise.reject(err);
      },
      PromiseResolve(val) {
        return Promise.resolve(val);
      },
      ReflectApply: Reflect.apply,
      RegExpPrototypeTest(self, value) {
        return self.test(value);
      },
      SafeSet: Set,
      String,
      StringPrototypeSlice(self, start, end) {
        return self.slice(start, end);
      },
      StringPrototypeToLowerCase(self) {
        return self.toLowerCase();
      },
      StringPrototypeToUpperCase(self) {
        return self.toUpperCase();
      },
      StringPrototypeTrim(self) {
        return self.trim();
      },
      Symbol,
      SymbolFor: Symbol.for,
      SymbolAsyncIterator: Symbol.asyncIterator,
      SymbolHasInstance: Symbol.hasInstance,
      SymbolIterator: Symbol.iterator,
      SymbolDispose: Symbol.dispose || /* @__PURE__ */ Symbol("Symbol.dispose"),
      SymbolAsyncDispose: Symbol.asyncDispose || /* @__PURE__ */ Symbol("Symbol.asyncDispose"),
      TypedArrayPrototypeSet(self, buf, len) {
        return self.set(buf, len);
      },
      Boolean,
      Uint8Array
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/util/inspect.js
var require_inspect = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/util/inspect.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      format(format, ...args) {
        return format.replace(/%([sdifj])/g, function(...[_unused, type]) {
          const replacement = args.shift();
          if (type === "f") {
            return replacement.toFixed(6);
          } else if (type === "j") {
            return JSON.stringify(replacement);
          } else if (type === "s" && typeof replacement === "object") {
            const ctor = replacement.constructor !== Object ? replacement.constructor.name : "";
            return `${ctor} {}`.trim();
          } else {
            return replacement.toString();
          }
        });
      },
      inspect(value) {
        switch (typeof value) {
          case "string":
            if (value.includes("'")) {
              if (!value.includes('"')) {
                return `"${value}"`;
              } else if (!value.includes("`") && !value.includes("${")) {
                return `\`${value}\``;
              }
            }
            return `'${value}'`;
          case "number":
            if (isNaN(value)) {
              return "NaN";
            } else if (Object.is(value, -0)) {
              return String(value);
            }
            return value;
          case "bigint":
            return `${String(value)}n`;
          case "boolean":
          case "undefined":
            return String(value);
          case "object":
            return "{}";
        }
      }
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/errors.js
var require_errors = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/errors.js"(exports2, module2) {
    "use strict";
    var { format, inspect } = require_inspect();
    var { AggregateError: CustomAggregateError } = require_primordials();
    var AggregateError = globalThis.AggregateError || CustomAggregateError;
    var kIsNodeError = /* @__PURE__ */ Symbol("kIsNodeError");
    var kTypes = [
      "string",
      "function",
      "number",
      "object",
      // Accept 'Function' and 'Object' as alternative to the lower cased version.
      "Function",
      "Object",
      "boolean",
      "bigint",
      "symbol"
    ];
    var classRegExp = /^([A-Z][a-z0-9]*)+$/;
    var nodeInternalPrefix = "__node_internal_";
    var codes = {};
    function assert(value, message) {
      if (!value) {
        throw new codes.ERR_INTERNAL_ASSERTION(message);
      }
    }
    function addNumericalSeparator(val) {
      let res = "";
      let i = val.length;
      const start = val[0] === "-" ? 1 : 0;
      for (; i >= start + 4; i -= 3) {
        res = `_${val.slice(i - 3, i)}${res}`;
      }
      return `${val.slice(0, i)}${res}`;
    }
    function getMessage(key, msg, args) {
      if (typeof msg === "function") {
        assert(
          msg.length <= args.length,
          // Default options do not count.
          `Code: ${key}; The provided arguments length (${args.length}) does not match the required ones (${msg.length}).`
        );
        return msg(...args);
      }
      const expectedLength = (msg.match(/%[dfijoOs]/g) || []).length;
      assert(
        expectedLength === args.length,
        `Code: ${key}; The provided arguments length (${args.length}) does not match the required ones (${expectedLength}).`
      );
      if (args.length === 0) {
        return msg;
      }
      return format(msg, ...args);
    }
    function E(code, message, Base) {
      if (!Base) {
        Base = Error;
      }
      class NodeError extends Base {
        constructor(...args) {
          super(getMessage(code, message, args));
        }
        toString() {
          return `${this.name} [${code}]: ${this.message}`;
        }
      }
      Object.defineProperties(NodeError.prototype, {
        name: {
          value: Base.name,
          writable: true,
          enumerable: false,
          configurable: true
        },
        toString: {
          value() {
            return `${this.name} [${code}]: ${this.message}`;
          },
          writable: true,
          enumerable: false,
          configurable: true
        }
      });
      NodeError.prototype.code = code;
      NodeError.prototype[kIsNodeError] = true;
      codes[code] = NodeError;
    }
    function hideStackFrames(fn) {
      const hidden = nodeInternalPrefix + fn.name;
      Object.defineProperty(fn, "name", {
        value: hidden
      });
      return fn;
    }
    function aggregateTwoErrors(innerError, outerError) {
      if (innerError && outerError && innerError !== outerError) {
        if (Array.isArray(outerError.errors)) {
          outerError.errors.push(innerError);
          return outerError;
        }
        const err = new AggregateError([outerError, innerError], outerError.message);
        err.code = outerError.code;
        return err;
      }
      return innerError || outerError;
    }
    var AbortError = class extends Error {
      constructor(message = "The operation was aborted", options = void 0) {
        if (options !== void 0 && typeof options !== "object") {
          throw new codes.ERR_INVALID_ARG_TYPE("options", "Object", options);
        }
        super(message, options);
        this.code = "ABORT_ERR";
        this.name = "AbortError";
      }
    };
    E("ERR_ASSERTION", "%s", Error);
    E(
      "ERR_INVALID_ARG_TYPE",
      (name, expected, actual) => {
        assert(typeof name === "string", "'name' must be a string");
        if (!Array.isArray(expected)) {
          expected = [expected];
        }
        let msg = "The ";
        if (name.endsWith(" argument")) {
          msg += `${name} `;
        } else {
          msg += `"${name}" ${name.includes(".") ? "property" : "argument"} `;
        }
        msg += "must be ";
        const types = [];
        const instances = [];
        const other = [];
        for (const value of expected) {
          assert(typeof value === "string", "All expected entries have to be of type string");
          if (kTypes.includes(value)) {
            types.push(value.toLowerCase());
          } else if (classRegExp.test(value)) {
            instances.push(value);
          } else {
            assert(value !== "object", 'The value "object" should be written as "Object"');
            other.push(value);
          }
        }
        if (instances.length > 0) {
          const pos = types.indexOf("object");
          if (pos !== -1) {
            types.splice(types, pos, 1);
            instances.push("Object");
          }
        }
        if (types.length > 0) {
          switch (types.length) {
            case 1:
              msg += `of type ${types[0]}`;
              break;
            case 2:
              msg += `one of type ${types[0]} or ${types[1]}`;
              break;
            default: {
              const last = types.pop();
              msg += `one of type ${types.join(", ")}, or ${last}`;
            }
          }
          if (instances.length > 0 || other.length > 0) {
            msg += " or ";
          }
        }
        if (instances.length > 0) {
          switch (instances.length) {
            case 1:
              msg += `an instance of ${instances[0]}`;
              break;
            case 2:
              msg += `an instance of ${instances[0]} or ${instances[1]}`;
              break;
            default: {
              const last = instances.pop();
              msg += `an instance of ${instances.join(", ")}, or ${last}`;
            }
          }
          if (other.length > 0) {
            msg += " or ";
          }
        }
        switch (other.length) {
          case 0:
            break;
          case 1:
            if (other[0].toLowerCase() !== other[0]) {
              msg += "an ";
            }
            msg += `${other[0]}`;
            break;
          case 2:
            msg += `one of ${other[0]} or ${other[1]}`;
            break;
          default: {
            const last = other.pop();
            msg += `one of ${other.join(", ")}, or ${last}`;
          }
        }
        if (actual == null) {
          msg += `. Received ${actual}`;
        } else if (typeof actual === "function" && actual.name) {
          msg += `. Received function ${actual.name}`;
        } else if (typeof actual === "object") {
          var _actual$constructor;
          if ((_actual$constructor = actual.constructor) !== null && _actual$constructor !== void 0 && _actual$constructor.name) {
            msg += `. Received an instance of ${actual.constructor.name}`;
          } else {
            const inspected = inspect(actual, {
              depth: -1
            });
            msg += `. Received ${inspected}`;
          }
        } else {
          let inspected = inspect(actual, {
            colors: false
          });
          if (inspected.length > 25) {
            inspected = `${inspected.slice(0, 25)}...`;
          }
          msg += `. Received type ${typeof actual} (${inspected})`;
        }
        return msg;
      },
      TypeError
    );
    E(
      "ERR_INVALID_ARG_VALUE",
      (name, value, reason = "is invalid") => {
        let inspected = inspect(value);
        if (inspected.length > 128) {
          inspected = inspected.slice(0, 128) + "...";
        }
        const type = name.includes(".") ? "property" : "argument";
        return `The ${type} '${name}' ${reason}. Received ${inspected}`;
      },
      TypeError
    );
    E(
      "ERR_INVALID_RETURN_VALUE",
      (input, name, value) => {
        var _value$constructor;
        const type = value !== null && value !== void 0 && (_value$constructor = value.constructor) !== null && _value$constructor !== void 0 && _value$constructor.name ? `instance of ${value.constructor.name}` : `type ${typeof value}`;
        return `Expected ${input} to be returned from the "${name}" function but got ${type}.`;
      },
      TypeError
    );
    E(
      "ERR_MISSING_ARGS",
      (...args) => {
        assert(args.length > 0, "At least one arg needs to be specified");
        let msg;
        const len = args.length;
        args = (Array.isArray(args) ? args : [args]).map((a) => `"${a}"`).join(" or ");
        switch (len) {
          case 1:
            msg += `The ${args[0]} argument`;
            break;
          case 2:
            msg += `The ${args[0]} and ${args[1]} arguments`;
            break;
          default:
            {
              const last = args.pop();
              msg += `The ${args.join(", ")}, and ${last} arguments`;
            }
            break;
        }
        return `${msg} must be specified`;
      },
      TypeError
    );
    E(
      "ERR_OUT_OF_RANGE",
      (str, range, input) => {
        assert(range, 'Missing "range" argument');
        let received;
        if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
          received = addNumericalSeparator(String(input));
        } else if (typeof input === "bigint") {
          received = String(input);
          const limit = BigInt(2) ** BigInt(32);
          if (input > limit || input < -limit) {
            received = addNumericalSeparator(received);
          }
          received += "n";
        } else {
          received = inspect(input);
        }
        return `The value of "${str}" is out of range. It must be ${range}. Received ${received}`;
      },
      RangeError
    );
    E("ERR_MULTIPLE_CALLBACK", "Callback called multiple times", Error);
    E("ERR_METHOD_NOT_IMPLEMENTED", "The %s method is not implemented", Error);
    E("ERR_STREAM_ALREADY_FINISHED", "Cannot call %s after a stream was finished", Error);
    E("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable", Error);
    E("ERR_STREAM_DESTROYED", "Cannot call %s after a stream was destroyed", Error);
    E("ERR_STREAM_NULL_VALUES", "May not write null values to stream", TypeError);
    E("ERR_STREAM_PREMATURE_CLOSE", "Premature close", Error);
    E("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF", Error);
    E("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event", Error);
    E("ERR_STREAM_WRITE_AFTER_END", "write after end", Error);
    E("ERR_UNKNOWN_ENCODING", "Unknown encoding: %s", TypeError);
    module2.exports = {
      AbortError,
      aggregateTwoErrors: hideStackFrames(aggregateTwoErrors),
      hideStackFrames,
      codes
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/event-target-shim/dist/event-target-shim.js
var require_event_target_shim = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/event-target-shim/dist/event-target-shim.js"(exports2, module2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var privateData = /* @__PURE__ */ new WeakMap();
    var wrappers = /* @__PURE__ */ new WeakMap();
    function pd(event) {
      const retv = privateData.get(event);
      console.assert(
        retv != null,
        "'this' is expected an Event object, but got",
        event
      );
      return retv;
    }
    function setCancelFlag(data) {
      if (data.passiveListener != null) {
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error(
            "Unable to preventDefault inside passive event listener invocation.",
            data.passiveListener
          );
        }
        return;
      }
      if (!data.event.cancelable) {
        return;
      }
      data.canceled = true;
      if (typeof data.event.preventDefault === "function") {
        data.event.preventDefault();
      }
    }
    function Event(eventTarget, event) {
      privateData.set(this, {
        eventTarget,
        event,
        eventPhase: 2,
        currentTarget: eventTarget,
        canceled: false,
        stopped: false,
        immediateStopped: false,
        passiveListener: null,
        timeStamp: event.timeStamp || Date.now()
      });
      Object.defineProperty(this, "isTrusted", { value: false, enumerable: true });
      const keys = Object.keys(event);
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        if (!(key in this)) {
          Object.defineProperty(this, key, defineRedirectDescriptor(key));
        }
      }
    }
    Event.prototype = {
      /**
       * The type of this event.
       * @type {string}
       */
      get type() {
        return pd(this).event.type;
      },
      /**
       * The target of this event.
       * @type {EventTarget}
       */
      get target() {
        return pd(this).eventTarget;
      },
      /**
       * The target of this event.
       * @type {EventTarget}
       */
      get currentTarget() {
        return pd(this).currentTarget;
      },
      /**
       * @returns {EventTarget[]} The composed path of this event.
       */
      composedPath() {
        const currentTarget = pd(this).currentTarget;
        if (currentTarget == null) {
          return [];
        }
        return [currentTarget];
      },
      /**
       * Constant of NONE.
       * @type {number}
       */
      get NONE() {
        return 0;
      },
      /**
       * Constant of CAPTURING_PHASE.
       * @type {number}
       */
      get CAPTURING_PHASE() {
        return 1;
      },
      /**
       * Constant of AT_TARGET.
       * @type {number}
       */
      get AT_TARGET() {
        return 2;
      },
      /**
       * Constant of BUBBLING_PHASE.
       * @type {number}
       */
      get BUBBLING_PHASE() {
        return 3;
      },
      /**
       * The target of this event.
       * @type {number}
       */
      get eventPhase() {
        return pd(this).eventPhase;
      },
      /**
       * Stop event bubbling.
       * @returns {void}
       */
      stopPropagation() {
        const data = pd(this);
        data.stopped = true;
        if (typeof data.event.stopPropagation === "function") {
          data.event.stopPropagation();
        }
      },
      /**
       * Stop event bubbling.
       * @returns {void}
       */
      stopImmediatePropagation() {
        const data = pd(this);
        data.stopped = true;
        data.immediateStopped = true;
        if (typeof data.event.stopImmediatePropagation === "function") {
          data.event.stopImmediatePropagation();
        }
      },
      /**
       * The flag to be bubbling.
       * @type {boolean}
       */
      get bubbles() {
        return Boolean(pd(this).event.bubbles);
      },
      /**
       * The flag to be cancelable.
       * @type {boolean}
       */
      get cancelable() {
        return Boolean(pd(this).event.cancelable);
      },
      /**
       * Cancel this event.
       * @returns {void}
       */
      preventDefault() {
        setCancelFlag(pd(this));
      },
      /**
       * The flag to indicate cancellation state.
       * @type {boolean}
       */
      get defaultPrevented() {
        return pd(this).canceled;
      },
      /**
       * The flag to be composed.
       * @type {boolean}
       */
      get composed() {
        return Boolean(pd(this).event.composed);
      },
      /**
       * The unix time of this event.
       * @type {number}
       */
      get timeStamp() {
        return pd(this).timeStamp;
      },
      /**
       * The target of this event.
       * @type {EventTarget}
       * @deprecated
       */
      get srcElement() {
        return pd(this).eventTarget;
      },
      /**
       * The flag to stop event bubbling.
       * @type {boolean}
       * @deprecated
       */
      get cancelBubble() {
        return pd(this).stopped;
      },
      set cancelBubble(value) {
        if (!value) {
          return;
        }
        const data = pd(this);
        data.stopped = true;
        if (typeof data.event.cancelBubble === "boolean") {
          data.event.cancelBubble = true;
        }
      },
      /**
       * The flag to indicate cancellation state.
       * @type {boolean}
       * @deprecated
       */
      get returnValue() {
        return !pd(this).canceled;
      },
      set returnValue(value) {
        if (!value) {
          setCancelFlag(pd(this));
        }
      },
      /**
       * Initialize this event object. But do nothing under event dispatching.
       * @param {string} type The event type.
       * @param {boolean} [bubbles=false] The flag to be possible to bubble up.
       * @param {boolean} [cancelable=false] The flag to be possible to cancel.
       * @deprecated
       */
      initEvent() {
      }
    };
    Object.defineProperty(Event.prototype, "constructor", {
      value: Event,
      configurable: true,
      writable: true
    });
    if (typeof window !== "undefined" && typeof window.Event !== "undefined") {
      Object.setPrototypeOf(Event.prototype, window.Event.prototype);
      wrappers.set(window.Event.prototype, Event);
    }
    function defineRedirectDescriptor(key) {
      return {
        get() {
          return pd(this).event[key];
        },
        set(value) {
          pd(this).event[key] = value;
        },
        configurable: true,
        enumerable: true
      };
    }
    function defineCallDescriptor(key) {
      return {
        value() {
          const event = pd(this).event;
          return event[key].apply(event, arguments);
        },
        configurable: true,
        enumerable: true
      };
    }
    function defineWrapper(BaseEvent, proto) {
      const keys = Object.keys(proto);
      if (keys.length === 0) {
        return BaseEvent;
      }
      function CustomEvent(eventTarget, event) {
        BaseEvent.call(this, eventTarget, event);
      }
      CustomEvent.prototype = Object.create(BaseEvent.prototype, {
        constructor: { value: CustomEvent, configurable: true, writable: true }
      });
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        if (!(key in BaseEvent.prototype)) {
          const descriptor = Object.getOwnPropertyDescriptor(proto, key);
          const isFunc = typeof descriptor.value === "function";
          Object.defineProperty(
            CustomEvent.prototype,
            key,
            isFunc ? defineCallDescriptor(key) : defineRedirectDescriptor(key)
          );
        }
      }
      return CustomEvent;
    }
    function getWrapper(proto) {
      if (proto == null || proto === Object.prototype) {
        return Event;
      }
      let wrapper = wrappers.get(proto);
      if (wrapper == null) {
        wrapper = defineWrapper(getWrapper(Object.getPrototypeOf(proto)), proto);
        wrappers.set(proto, wrapper);
      }
      return wrapper;
    }
    function wrapEvent(eventTarget, event) {
      const Wrapper = getWrapper(Object.getPrototypeOf(event));
      return new Wrapper(eventTarget, event);
    }
    function isStopped(event) {
      return pd(event).immediateStopped;
    }
    function setEventPhase(event, eventPhase) {
      pd(event).eventPhase = eventPhase;
    }
    function setCurrentTarget(event, currentTarget) {
      pd(event).currentTarget = currentTarget;
    }
    function setPassiveListener(event, passiveListener) {
      pd(event).passiveListener = passiveListener;
    }
    var listenersMap = /* @__PURE__ */ new WeakMap();
    var CAPTURE = 1;
    var BUBBLE = 2;
    var ATTRIBUTE = 3;
    function isObject(x) {
      return x !== null && typeof x === "object";
    }
    function getListeners(eventTarget) {
      const listeners = listenersMap.get(eventTarget);
      if (listeners == null) {
        throw new TypeError(
          "'this' is expected an EventTarget object, but got another value."
        );
      }
      return listeners;
    }
    function defineEventAttributeDescriptor(eventName) {
      return {
        get() {
          const listeners = getListeners(this);
          let node = listeners.get(eventName);
          while (node != null) {
            if (node.listenerType === ATTRIBUTE) {
              return node.listener;
            }
            node = node.next;
          }
          return null;
        },
        set(listener) {
          if (typeof listener !== "function" && !isObject(listener)) {
            listener = null;
          }
          const listeners = getListeners(this);
          let prev = null;
          let node = listeners.get(eventName);
          while (node != null) {
            if (node.listenerType === ATTRIBUTE) {
              if (prev !== null) {
                prev.next = node.next;
              } else if (node.next !== null) {
                listeners.set(eventName, node.next);
              } else {
                listeners.delete(eventName);
              }
            } else {
              prev = node;
            }
            node = node.next;
          }
          if (listener !== null) {
            const newNode = {
              listener,
              listenerType: ATTRIBUTE,
              passive: false,
              once: false,
              next: null
            };
            if (prev === null) {
              listeners.set(eventName, newNode);
            } else {
              prev.next = newNode;
            }
          }
        },
        configurable: true,
        enumerable: true
      };
    }
    function defineEventAttribute(eventTargetPrototype, eventName) {
      Object.defineProperty(
        eventTargetPrototype,
        `on${eventName}`,
        defineEventAttributeDescriptor(eventName)
      );
    }
    function defineCustomEventTarget(eventNames) {
      function CustomEventTarget() {
        EventTarget.call(this);
      }
      CustomEventTarget.prototype = Object.create(EventTarget.prototype, {
        constructor: {
          value: CustomEventTarget,
          configurable: true,
          writable: true
        }
      });
      for (let i = 0; i < eventNames.length; ++i) {
        defineEventAttribute(CustomEventTarget.prototype, eventNames[i]);
      }
      return CustomEventTarget;
    }
    function EventTarget() {
      if (this instanceof EventTarget) {
        listenersMap.set(this, /* @__PURE__ */ new Map());
        return;
      }
      if (arguments.length === 1 && Array.isArray(arguments[0])) {
        return defineCustomEventTarget(arguments[0]);
      }
      if (arguments.length > 0) {
        const types = new Array(arguments.length);
        for (let i = 0; i < arguments.length; ++i) {
          types[i] = arguments[i];
        }
        return defineCustomEventTarget(types);
      }
      throw new TypeError("Cannot call a class as a function");
    }
    EventTarget.prototype = {
      /**
       * Add a given listener to this event target.
       * @param {string} eventName The event name to add.
       * @param {Function} listener The listener to add.
       * @param {boolean|{capture?:boolean,passive?:boolean,once?:boolean}} [options] The options for this listener.
       * @returns {void}
       */
      addEventListener(eventName, listener, options) {
        if (listener == null) {
          return;
        }
        if (typeof listener !== "function" && !isObject(listener)) {
          throw new TypeError("'listener' should be a function or an object.");
        }
        const listeners = getListeners(this);
        const optionsIsObj = isObject(options);
        const capture = optionsIsObj ? Boolean(options.capture) : Boolean(options);
        const listenerType = capture ? CAPTURE : BUBBLE;
        const newNode = {
          listener,
          listenerType,
          passive: optionsIsObj && Boolean(options.passive),
          once: optionsIsObj && Boolean(options.once),
          next: null
        };
        let node = listeners.get(eventName);
        if (node === void 0) {
          listeners.set(eventName, newNode);
          return;
        }
        let prev = null;
        while (node != null) {
          if (node.listener === listener && node.listenerType === listenerType) {
            return;
          }
          prev = node;
          node = node.next;
        }
        prev.next = newNode;
      },
      /**
       * Remove a given listener from this event target.
       * @param {string} eventName The event name to remove.
       * @param {Function} listener The listener to remove.
       * @param {boolean|{capture?:boolean,passive?:boolean,once?:boolean}} [options] The options for this listener.
       * @returns {void}
       */
      removeEventListener(eventName, listener, options) {
        if (listener == null) {
          return;
        }
        const listeners = getListeners(this);
        const capture = isObject(options) ? Boolean(options.capture) : Boolean(options);
        const listenerType = capture ? CAPTURE : BUBBLE;
        let prev = null;
        let node = listeners.get(eventName);
        while (node != null) {
          if (node.listener === listener && node.listenerType === listenerType) {
            if (prev !== null) {
              prev.next = node.next;
            } else if (node.next !== null) {
              listeners.set(eventName, node.next);
            } else {
              listeners.delete(eventName);
            }
            return;
          }
          prev = node;
          node = node.next;
        }
      },
      /**
       * Dispatch a given event.
       * @param {Event|{type:string}} event The event to dispatch.
       * @returns {boolean} `false` if canceled.
       */
      dispatchEvent(event) {
        if (event == null || typeof event.type !== "string") {
          throw new TypeError('"event.type" should be a string.');
        }
        const listeners = getListeners(this);
        const eventName = event.type;
        let node = listeners.get(eventName);
        if (node == null) {
          return true;
        }
        const wrappedEvent = wrapEvent(this, event);
        let prev = null;
        while (node != null) {
          if (node.once) {
            if (prev !== null) {
              prev.next = node.next;
            } else if (node.next !== null) {
              listeners.set(eventName, node.next);
            } else {
              listeners.delete(eventName);
            }
          } else {
            prev = node;
          }
          setPassiveListener(
            wrappedEvent,
            node.passive ? node.listener : null
          );
          if (typeof node.listener === "function") {
            try {
              node.listener.call(this, wrappedEvent);
            } catch (err) {
              if (typeof console !== "undefined" && typeof console.error === "function") {
                console.error(err);
              }
            }
          } else if (node.listenerType !== ATTRIBUTE && typeof node.listener.handleEvent === "function") {
            node.listener.handleEvent(wrappedEvent);
          }
          if (isStopped(wrappedEvent)) {
            break;
          }
          node = node.next;
        }
        setPassiveListener(wrappedEvent, null);
        setEventPhase(wrappedEvent, 0);
        setCurrentTarget(wrappedEvent, null);
        return !wrappedEvent.defaultPrevented;
      }
    };
    Object.defineProperty(EventTarget.prototype, "constructor", {
      value: EventTarget,
      configurable: true,
      writable: true
    });
    if (typeof window !== "undefined" && typeof window.EventTarget !== "undefined") {
      Object.setPrototypeOf(EventTarget.prototype, window.EventTarget.prototype);
    }
    exports2.defineEventAttribute = defineEventAttribute;
    exports2.EventTarget = EventTarget;
    exports2.default = EventTarget;
    module2.exports = EventTarget;
    module2.exports.EventTarget = module2.exports["default"] = EventTarget;
    module2.exports.defineEventAttribute = defineEventAttribute;
  }
});

// Local/临时/test_isogit_bundle/node_modules/abort-controller/dist/abort-controller.js
var require_abort_controller = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/abort-controller/dist/abort-controller.js"(exports2, module2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var eventTargetShim = require_event_target_shim();
    var AbortSignal = class extends eventTargetShim.EventTarget {
      /**
       * AbortSignal cannot be constructed directly.
       */
      constructor() {
        super();
        throw new TypeError("AbortSignal cannot be constructed directly");
      }
      /**
       * Returns `true` if this `AbortSignal`'s `AbortController` has signaled to abort, and `false` otherwise.
       */
      get aborted() {
        const aborted = abortedFlags.get(this);
        if (typeof aborted !== "boolean") {
          throw new TypeError(`Expected 'this' to be an 'AbortSignal' object, but got ${this === null ? "null" : typeof this}`);
        }
        return aborted;
      }
    };
    eventTargetShim.defineEventAttribute(AbortSignal.prototype, "abort");
    function createAbortSignal() {
      const signal = Object.create(AbortSignal.prototype);
      eventTargetShim.EventTarget.call(signal);
      abortedFlags.set(signal, false);
      return signal;
    }
    function abortSignal(signal) {
      if (abortedFlags.get(signal) !== false) {
        return;
      }
      abortedFlags.set(signal, true);
      signal.dispatchEvent({ type: "abort" });
    }
    var abortedFlags = /* @__PURE__ */ new WeakMap();
    Object.defineProperties(AbortSignal.prototype, {
      aborted: { enumerable: true }
    });
    if (typeof Symbol === "function" && typeof Symbol.toStringTag === "symbol") {
      Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, {
        configurable: true,
        value: "AbortSignal"
      });
    }
    var AbortController = class {
      /**
       * Initialize this controller.
       */
      constructor() {
        signals.set(this, createAbortSignal());
      }
      /**
       * Returns the `AbortSignal` object associated with this object.
       */
      get signal() {
        return getSignal(this);
      }
      /**
       * Abort and signal to any observers that the associated activity is to be aborted.
       */
      abort() {
        abortSignal(getSignal(this));
      }
    };
    var signals = /* @__PURE__ */ new WeakMap();
    function getSignal(controller) {
      const signal = signals.get(controller);
      if (signal == null) {
        throw new TypeError(`Expected 'this' to be an 'AbortController' object, but got ${controller === null ? "null" : typeof controller}`);
      }
      return signal;
    }
    Object.defineProperties(AbortController.prototype, {
      signal: { enumerable: true },
      abort: { enumerable: true }
    });
    if (typeof Symbol === "function" && typeof Symbol.toStringTag === "symbol") {
      Object.defineProperty(AbortController.prototype, Symbol.toStringTag, {
        configurable: true,
        value: "AbortController"
      });
    }
    exports2.AbortController = AbortController;
    exports2.AbortSignal = AbortSignal;
    exports2.default = AbortController;
    module2.exports = AbortController;
    module2.exports.AbortController = module2.exports["default"] = AbortController;
    module2.exports.AbortSignal = AbortSignal;
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/util.js
var require_util = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/util.js"(exports2, module2) {
    "use strict";
    var bufferModule = require("buffer");
    var { format, inspect } = require_inspect();
    var {
      codes: { ERR_INVALID_ARG_TYPE }
    } = require_errors();
    var { kResistStopPropagation, AggregateError, SymbolDispose } = require_primordials();
    var AbortSignal = globalThis.AbortSignal || require_abort_controller().AbortSignal;
    var AbortController = globalThis.AbortController || require_abort_controller().AbortController;
    var AsyncFunction = Object.getPrototypeOf(async function() {
    }).constructor;
    var Blob = globalThis.Blob || bufferModule.Blob;
    var isBlob = typeof Blob !== "undefined" ? function isBlob2(b) {
      return b instanceof Blob;
    } : function isBlob2(b) {
      return false;
    };
    var validateAbortSignal = (signal, name) => {
      if (signal !== void 0 && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
        throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
      }
    };
    var validateFunction = (value, name) => {
      if (typeof value !== "function") {
        throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
      }
    };
    module2.exports = {
      AggregateError,
      kEmptyObject: Object.freeze({}),
      once(callback) {
        let called = false;
        return function(...args) {
          if (called) {
            return;
          }
          called = true;
          callback.apply(this, args);
        };
      },
      createDeferredPromise: function() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return {
          promise,
          resolve,
          reject
        };
      },
      promisify(fn) {
        return new Promise((resolve, reject) => {
          fn((err, ...args) => {
            if (err) {
              return reject(err);
            }
            return resolve(...args);
          });
        });
      },
      debuglog() {
        return function() {
        };
      },
      format,
      inspect,
      types: {
        isAsyncFunction(fn) {
          return fn instanceof AsyncFunction;
        },
        isArrayBufferView(arr) {
          return ArrayBuffer.isView(arr);
        }
      },
      isBlob,
      deprecate(fn, message) {
        return fn;
      },
      addAbortListener: require("events").addAbortListener || function addAbortListener(signal, listener) {
        if (signal === void 0) {
          throw new ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
        }
        validateAbortSignal(signal, "signal");
        validateFunction(listener, "listener");
        let removeEventListener;
        if (signal.aborted) {
          queueMicrotask(() => listener());
        } else {
          signal.addEventListener("abort", listener, {
            __proto__: null,
            once: true,
            [kResistStopPropagation]: true
          });
          removeEventListener = () => {
            signal.removeEventListener("abort", listener);
          };
        }
        return {
          __proto__: null,
          [SymbolDispose]() {
            var _removeEventListener;
            (_removeEventListener = removeEventListener) === null || _removeEventListener === void 0 ? void 0 : _removeEventListener();
          }
        };
      },
      AbortSignalAny: AbortSignal.any || function AbortSignalAny(signals) {
        if (signals.length === 1) {
          return signals[0];
        }
        const ac = new AbortController();
        const abort = () => ac.abort();
        signals.forEach((signal) => {
          validateAbortSignal(signal, "signals");
          signal.addEventListener("abort", abort, {
            once: true
          });
        });
        ac.signal.addEventListener(
          "abort",
          () => {
            signals.forEach((signal) => signal.removeEventListener("abort", abort));
          },
          {
            once: true
          }
        );
        return ac.signal;
      }
    };
    module2.exports.promisify.custom = /* @__PURE__ */ Symbol.for("nodejs.util.promisify.custom");
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/validators.js
var require_validators = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/validators.js"(exports2, module2) {
    "use strict";
    var {
      ArrayIsArray,
      ArrayPrototypeIncludes,
      ArrayPrototypeJoin,
      ArrayPrototypeMap,
      NumberIsInteger,
      NumberIsNaN,
      NumberMAX_SAFE_INTEGER,
      NumberMIN_SAFE_INTEGER,
      NumberParseInt,
      ObjectPrototypeHasOwnProperty,
      RegExpPrototypeExec,
      String: String2,
      StringPrototypeToUpperCase,
      StringPrototypeTrim
    } = require_primordials();
    var {
      hideStackFrames,
      codes: { ERR_SOCKET_BAD_PORT, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE, ERR_UNKNOWN_SIGNAL }
    } = require_errors();
    var { normalizeEncoding } = require_util();
    var { isAsyncFunction, isArrayBufferView } = require_util().types;
    var signals = {};
    function isInt32(value) {
      return value === (value | 0);
    }
    function isUint32(value) {
      return value === value >>> 0;
    }
    var octalReg = /^[0-7]+$/;
    var modeDesc = "must be a 32-bit unsigned integer or an octal string";
    function parseFileMode(value, name, def) {
      if (typeof value === "undefined") {
        value = def;
      }
      if (typeof value === "string") {
        if (RegExpPrototypeExec(octalReg, value) === null) {
          throw new ERR_INVALID_ARG_VALUE(name, value, modeDesc);
        }
        value = NumberParseInt(value, 8);
      }
      validateUint32(value, name);
      return value;
    }
    var validateInteger = hideStackFrames((value, name, min = NumberMIN_SAFE_INTEGER, max = NumberMAX_SAFE_INTEGER) => {
      if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
      if (!NumberIsInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
      if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
    });
    var validateInt32 = hideStackFrames((value, name, min = -2147483648, max = 2147483647) => {
      if (typeof value !== "number") {
        throw new ERR_INVALID_ARG_TYPE(name, "number", value);
      }
      if (!NumberIsInteger(value)) {
        throw new ERR_OUT_OF_RANGE(name, "an integer", value);
      }
      if (value < min || value > max) {
        throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
      }
    });
    var validateUint32 = hideStackFrames((value, name, positive = false) => {
      if (typeof value !== "number") {
        throw new ERR_INVALID_ARG_TYPE(name, "number", value);
      }
      if (!NumberIsInteger(value)) {
        throw new ERR_OUT_OF_RANGE(name, "an integer", value);
      }
      const min = positive ? 1 : 0;
      const max = 4294967295;
      if (value < min || value > max) {
        throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
      }
    });
    function validateString(value, name) {
      if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
    }
    function validateNumber(value, name, min = void 0, max) {
      if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
      if (min != null && value < min || max != null && value > max || (min != null || max != null) && NumberIsNaN(value)) {
        throw new ERR_OUT_OF_RANGE(
          name,
          `${min != null ? `>= ${min}` : ""}${min != null && max != null ? " && " : ""}${max != null ? `<= ${max}` : ""}`,
          value
        );
      }
    }
    var validateOneOf = hideStackFrames((value, name, oneOf) => {
      if (!ArrayPrototypeIncludes(oneOf, value)) {
        const allowed = ArrayPrototypeJoin(
          ArrayPrototypeMap(oneOf, (v) => typeof v === "string" ? `'${v}'` : String2(v)),
          ", "
        );
        const reason = "must be one of: " + allowed;
        throw new ERR_INVALID_ARG_VALUE(name, value, reason);
      }
    });
    function validateBoolean(value, name) {
      if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
    }
    function getOwnPropertyValueOrDefault(options, key, defaultValue) {
      return options == null || !ObjectPrototypeHasOwnProperty(options, key) ? defaultValue : options[key];
    }
    var validateObject = hideStackFrames((value, name, options = null) => {
      const allowArray = getOwnPropertyValueOrDefault(options, "allowArray", false);
      const allowFunction = getOwnPropertyValueOrDefault(options, "allowFunction", false);
      const nullable = getOwnPropertyValueOrDefault(options, "nullable", false);
      if (!nullable && value === null || !allowArray && ArrayIsArray(value) || typeof value !== "object" && (!allowFunction || typeof value !== "function")) {
        throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
      }
    });
    var validateDictionary = hideStackFrames((value, name) => {
      if (value != null && typeof value !== "object" && typeof value !== "function") {
        throw new ERR_INVALID_ARG_TYPE(name, "a dictionary", value);
      }
    });
    var validateArray = hideStackFrames((value, name, minLength = 0) => {
      if (!ArrayIsArray(value)) {
        throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
      }
      if (value.length < minLength) {
        const reason = `must be longer than ${minLength}`;
        throw new ERR_INVALID_ARG_VALUE(name, value, reason);
      }
    });
    function validateStringArray(value, name) {
      validateArray(value, name);
      for (let i = 0; i < value.length; i++) {
        validateString(value[i], `${name}[${i}]`);
      }
    }
    function validateBooleanArray(value, name) {
      validateArray(value, name);
      for (let i = 0; i < value.length; i++) {
        validateBoolean(value[i], `${name}[${i}]`);
      }
    }
    function validateAbortSignalArray(value, name) {
      validateArray(value, name);
      for (let i = 0; i < value.length; i++) {
        const signal = value[i];
        const indexedName = `${name}[${i}]`;
        if (signal == null) {
          throw new ERR_INVALID_ARG_TYPE(indexedName, "AbortSignal", signal);
        }
        validateAbortSignal(signal, indexedName);
      }
    }
    function validateSignalName(signal, name = "signal") {
      validateString(signal, name);
      if (signals[signal] === void 0) {
        if (signals[StringPrototypeToUpperCase(signal)] !== void 0) {
          throw new ERR_UNKNOWN_SIGNAL(signal + " (signals must use all capital letters)");
        }
        throw new ERR_UNKNOWN_SIGNAL(signal);
      }
    }
    var validateBuffer = hideStackFrames((buffer, name = "buffer") => {
      if (!isArrayBufferView(buffer)) {
        throw new ERR_INVALID_ARG_TYPE(name, ["Buffer", "TypedArray", "DataView"], buffer);
      }
    });
    function validateEncoding(data, encoding) {
      const normalizedEncoding = normalizeEncoding(encoding);
      const length = data.length;
      if (normalizedEncoding === "hex" && length % 2 !== 0) {
        throw new ERR_INVALID_ARG_VALUE("encoding", encoding, `is invalid for data of length ${length}`);
      }
    }
    function validatePort(port, name = "Port", allowZero = true) {
      if (typeof port !== "number" && typeof port !== "string" || typeof port === "string" && StringPrototypeTrim(port).length === 0 || +port !== +port >>> 0 || port > 65535 || port === 0 && !allowZero) {
        throw new ERR_SOCKET_BAD_PORT(name, port, allowZero);
      }
      return port | 0;
    }
    var validateAbortSignal = hideStackFrames((signal, name) => {
      if (signal !== void 0 && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
        throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
      }
    });
    var validateFunction = hideStackFrames((value, name) => {
      if (typeof value !== "function") throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
    });
    var validatePlainFunction = hideStackFrames((value, name) => {
      if (typeof value !== "function" || isAsyncFunction(value)) throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
    });
    var validateUndefined = hideStackFrames((value, name) => {
      if (value !== void 0) throw new ERR_INVALID_ARG_TYPE(name, "undefined", value);
    });
    function validateUnion(value, name, union) {
      if (!ArrayPrototypeIncludes(union, value)) {
        throw new ERR_INVALID_ARG_TYPE(name, `('${ArrayPrototypeJoin(union, "|")}')`, value);
      }
    }
    var linkValueRegExp = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(")?[^;"\s]*\1)?)*$/;
    function validateLinkHeaderFormat(value, name) {
      if (typeof value === "undefined" || !RegExpPrototypeExec(linkValueRegExp, value)) {
        throw new ERR_INVALID_ARG_VALUE(
          name,
          value,
          'must be an array or string of format "</styles.css>; rel=preload; as=style"'
        );
      }
    }
    function validateLinkHeaderValue(hints) {
      if (typeof hints === "string") {
        validateLinkHeaderFormat(hints, "hints");
        return hints;
      } else if (ArrayIsArray(hints)) {
        const hintsLength = hints.length;
        let result = "";
        if (hintsLength === 0) {
          return result;
        }
        for (let i = 0; i < hintsLength; i++) {
          const link = hints[i];
          validateLinkHeaderFormat(link, "hints");
          result += link;
          if (i !== hintsLength - 1) {
            result += ", ";
          }
        }
        return result;
      }
      throw new ERR_INVALID_ARG_VALUE(
        "hints",
        hints,
        'must be an array or string of format "</styles.css>; rel=preload; as=style"'
      );
    }
    module2.exports = {
      isInt32,
      isUint32,
      parseFileMode,
      validateArray,
      validateStringArray,
      validateBooleanArray,
      validateAbortSignalArray,
      validateBoolean,
      validateBuffer,
      validateDictionary,
      validateEncoding,
      validateFunction,
      validateInt32,
      validateInteger,
      validateNumber,
      validateObject,
      validateOneOf,
      validatePlainFunction,
      validatePort,
      validateSignalName,
      validateString,
      validateUint32,
      validateUndefined,
      validateUnion,
      validateAbortSignal,
      validateLinkHeaderValue
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/process/index.js
var require_process = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/process/index.js"(exports2, module2) {
    module2.exports = global.process;
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/utils.js
var require_utils = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/utils.js"(exports2, module2) {
    "use strict";
    var { SymbolAsyncIterator, SymbolIterator, SymbolFor } = require_primordials();
    var kIsDestroyed = SymbolFor("nodejs.stream.destroyed");
    var kIsErrored = SymbolFor("nodejs.stream.errored");
    var kIsReadable = SymbolFor("nodejs.stream.readable");
    var kIsWritable = SymbolFor("nodejs.stream.writable");
    var kIsDisturbed = SymbolFor("nodejs.stream.disturbed");
    var kIsClosedPromise = SymbolFor("nodejs.webstream.isClosedPromise");
    var kControllerErrorFunction = SymbolFor("nodejs.webstream.controllerErrorFunction");
    function isReadableNodeStream(obj, strict = false) {
      var _obj$_readableState;
      return !!(obj && typeof obj.pipe === "function" && typeof obj.on === "function" && (!strict || typeof obj.pause === "function" && typeof obj.resume === "function") && (!obj._writableState || ((_obj$_readableState = obj._readableState) === null || _obj$_readableState === void 0 ? void 0 : _obj$_readableState.readable) !== false) && // Duplex
      (!obj._writableState || obj._readableState));
    }
    function isWritableNodeStream(obj) {
      var _obj$_writableState;
      return !!(obj && typeof obj.write === "function" && typeof obj.on === "function" && (!obj._readableState || ((_obj$_writableState = obj._writableState) === null || _obj$_writableState === void 0 ? void 0 : _obj$_writableState.writable) !== false));
    }
    function isDuplexNodeStream(obj) {
      return !!(obj && typeof obj.pipe === "function" && obj._readableState && typeof obj.on === "function" && typeof obj.write === "function");
    }
    function isNodeStream(obj) {
      return obj && (obj._readableState || obj._writableState || typeof obj.write === "function" && typeof obj.on === "function" || typeof obj.pipe === "function" && typeof obj.on === "function");
    }
    function isReadableStream(obj) {
      return !!(obj && !isNodeStream(obj) && typeof obj.pipeThrough === "function" && typeof obj.getReader === "function" && typeof obj.cancel === "function");
    }
    function isWritableStream(obj) {
      return !!(obj && !isNodeStream(obj) && typeof obj.getWriter === "function" && typeof obj.abort === "function");
    }
    function isTransformStream(obj) {
      return !!(obj && !isNodeStream(obj) && typeof obj.readable === "object" && typeof obj.writable === "object");
    }
    function isWebStream(obj) {
      return isReadableStream(obj) || isWritableStream(obj) || isTransformStream(obj);
    }
    function isIterable(obj, isAsync) {
      if (obj == null) return false;
      if (isAsync === true) return typeof obj[SymbolAsyncIterator] === "function";
      if (isAsync === false) return typeof obj[SymbolIterator] === "function";
      return typeof obj[SymbolAsyncIterator] === "function" || typeof obj[SymbolIterator] === "function";
    }
    function isDestroyed(stream) {
      if (!isNodeStream(stream)) return null;
      const wState = stream._writableState;
      const rState = stream._readableState;
      const state = wState || rState;
      return !!(stream.destroyed || stream[kIsDestroyed] || state !== null && state !== void 0 && state.destroyed);
    }
    function isWritableEnded(stream) {
      if (!isWritableNodeStream(stream)) return null;
      if (stream.writableEnded === true) return true;
      const wState = stream._writableState;
      if (wState !== null && wState !== void 0 && wState.errored) return false;
      if (typeof (wState === null || wState === void 0 ? void 0 : wState.ended) !== "boolean") return null;
      return wState.ended;
    }
    function isWritableFinished(stream, strict) {
      if (!isWritableNodeStream(stream)) return null;
      if (stream.writableFinished === true) return true;
      const wState = stream._writableState;
      if (wState !== null && wState !== void 0 && wState.errored) return false;
      if (typeof (wState === null || wState === void 0 ? void 0 : wState.finished) !== "boolean") return null;
      return !!(wState.finished || strict === false && wState.ended === true && wState.length === 0);
    }
    function isReadableEnded(stream) {
      if (!isReadableNodeStream(stream)) return null;
      if (stream.readableEnded === true) return true;
      const rState = stream._readableState;
      if (!rState || rState.errored) return false;
      if (typeof (rState === null || rState === void 0 ? void 0 : rState.ended) !== "boolean") return null;
      return rState.ended;
    }
    function isReadableFinished(stream, strict) {
      if (!isReadableNodeStream(stream)) return null;
      const rState = stream._readableState;
      if (rState !== null && rState !== void 0 && rState.errored) return false;
      if (typeof (rState === null || rState === void 0 ? void 0 : rState.endEmitted) !== "boolean") return null;
      return !!(rState.endEmitted || strict === false && rState.ended === true && rState.length === 0);
    }
    function isReadable(stream) {
      if (stream && stream[kIsReadable] != null) return stream[kIsReadable];
      if (typeof (stream === null || stream === void 0 ? void 0 : stream.readable) !== "boolean") return null;
      if (isDestroyed(stream)) return false;
      return isReadableNodeStream(stream) && stream.readable && !isReadableFinished(stream);
    }
    function isWritable(stream) {
      if (stream && stream[kIsWritable] != null) return stream[kIsWritable];
      if (typeof (stream === null || stream === void 0 ? void 0 : stream.writable) !== "boolean") return null;
      if (isDestroyed(stream)) return false;
      return isWritableNodeStream(stream) && stream.writable && !isWritableEnded(stream);
    }
    function isFinished(stream, opts) {
      if (!isNodeStream(stream)) {
        return null;
      }
      if (isDestroyed(stream)) {
        return true;
      }
      if ((opts === null || opts === void 0 ? void 0 : opts.readable) !== false && isReadable(stream)) {
        return false;
      }
      if ((opts === null || opts === void 0 ? void 0 : opts.writable) !== false && isWritable(stream)) {
        return false;
      }
      return true;
    }
    function isWritableErrored(stream) {
      var _stream$_writableStat, _stream$_writableStat2;
      if (!isNodeStream(stream)) {
        return null;
      }
      if (stream.writableErrored) {
        return stream.writableErrored;
      }
      return (_stream$_writableStat = (_stream$_writableStat2 = stream._writableState) === null || _stream$_writableStat2 === void 0 ? void 0 : _stream$_writableStat2.errored) !== null && _stream$_writableStat !== void 0 ? _stream$_writableStat : null;
    }
    function isReadableErrored(stream) {
      var _stream$_readableStat, _stream$_readableStat2;
      if (!isNodeStream(stream)) {
        return null;
      }
      if (stream.readableErrored) {
        return stream.readableErrored;
      }
      return (_stream$_readableStat = (_stream$_readableStat2 = stream._readableState) === null || _stream$_readableStat2 === void 0 ? void 0 : _stream$_readableStat2.errored) !== null && _stream$_readableStat !== void 0 ? _stream$_readableStat : null;
    }
    function isClosed(stream) {
      if (!isNodeStream(stream)) {
        return null;
      }
      if (typeof stream.closed === "boolean") {
        return stream.closed;
      }
      const wState = stream._writableState;
      const rState = stream._readableState;
      if (typeof (wState === null || wState === void 0 ? void 0 : wState.closed) === "boolean" || typeof (rState === null || rState === void 0 ? void 0 : rState.closed) === "boolean") {
        return (wState === null || wState === void 0 ? void 0 : wState.closed) || (rState === null || rState === void 0 ? void 0 : rState.closed);
      }
      if (typeof stream._closed === "boolean" && isOutgoingMessage(stream)) {
        return stream._closed;
      }
      return null;
    }
    function isOutgoingMessage(stream) {
      return typeof stream._closed === "boolean" && typeof stream._defaultKeepAlive === "boolean" && typeof stream._removedConnection === "boolean" && typeof stream._removedContLen === "boolean";
    }
    function isServerResponse(stream) {
      return typeof stream._sent100 === "boolean" && isOutgoingMessage(stream);
    }
    function isServerRequest(stream) {
      var _stream$req;
      return typeof stream._consuming === "boolean" && typeof stream._dumped === "boolean" && ((_stream$req = stream.req) === null || _stream$req === void 0 ? void 0 : _stream$req.upgradeOrConnect) === void 0;
    }
    function willEmitClose(stream) {
      if (!isNodeStream(stream)) return null;
      const wState = stream._writableState;
      const rState = stream._readableState;
      const state = wState || rState;
      return !state && isServerResponse(stream) || !!(state && state.autoDestroy && state.emitClose && state.closed === false);
    }
    function isDisturbed(stream) {
      var _stream$kIsDisturbed;
      return !!(stream && ((_stream$kIsDisturbed = stream[kIsDisturbed]) !== null && _stream$kIsDisturbed !== void 0 ? _stream$kIsDisturbed : stream.readableDidRead || stream.readableAborted));
    }
    function isErrored(stream) {
      var _ref, _ref2, _ref3, _ref4, _ref5, _stream$kIsErrored, _stream$_readableStat3, _stream$_writableStat3, _stream$_readableStat4, _stream$_writableStat4;
      return !!(stream && ((_ref = (_ref2 = (_ref3 = (_ref4 = (_ref5 = (_stream$kIsErrored = stream[kIsErrored]) !== null && _stream$kIsErrored !== void 0 ? _stream$kIsErrored : stream.readableErrored) !== null && _ref5 !== void 0 ? _ref5 : stream.writableErrored) !== null && _ref4 !== void 0 ? _ref4 : (_stream$_readableStat3 = stream._readableState) === null || _stream$_readableStat3 === void 0 ? void 0 : _stream$_readableStat3.errorEmitted) !== null && _ref3 !== void 0 ? _ref3 : (_stream$_writableStat3 = stream._writableState) === null || _stream$_writableStat3 === void 0 ? void 0 : _stream$_writableStat3.errorEmitted) !== null && _ref2 !== void 0 ? _ref2 : (_stream$_readableStat4 = stream._readableState) === null || _stream$_readableStat4 === void 0 ? void 0 : _stream$_readableStat4.errored) !== null && _ref !== void 0 ? _ref : (_stream$_writableStat4 = stream._writableState) === null || _stream$_writableStat4 === void 0 ? void 0 : _stream$_writableStat4.errored));
    }
    module2.exports = {
      isDestroyed,
      kIsDestroyed,
      isDisturbed,
      kIsDisturbed,
      isErrored,
      kIsErrored,
      isReadable,
      kIsReadable,
      kIsClosedPromise,
      kControllerErrorFunction,
      kIsWritable,
      isClosed,
      isDuplexNodeStream,
      isFinished,
      isIterable,
      isReadableNodeStream,
      isReadableStream,
      isReadableEnded,
      isReadableFinished,
      isReadableErrored,
      isNodeStream,
      isWebStream,
      isWritable,
      isWritableNodeStream,
      isWritableStream,
      isWritableEnded,
      isWritableFinished,
      isWritableErrored,
      isServerRequest,
      isServerResponse,
      willEmitClose,
      isTransformStream
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/end-of-stream.js
var require_end_of_stream = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/end-of-stream.js"(exports2, module2) {
    "use strict";
    var process2 = require_process();
    var { AbortError, codes } = require_errors();
    var { ERR_INVALID_ARG_TYPE, ERR_STREAM_PREMATURE_CLOSE } = codes;
    var { kEmptyObject, once } = require_util();
    var { validateAbortSignal, validateFunction, validateObject, validateBoolean } = require_validators();
    var { Promise: Promise2, PromisePrototypeThen, SymbolDispose } = require_primordials();
    var {
      isClosed,
      isReadable,
      isReadableNodeStream,
      isReadableStream,
      isReadableFinished,
      isReadableErrored,
      isWritable,
      isWritableNodeStream,
      isWritableStream,
      isWritableFinished,
      isWritableErrored,
      isNodeStream,
      willEmitClose: _willEmitClose,
      kIsClosedPromise
    } = require_utils();
    var addAbortListener;
    function isRequest(stream) {
      return stream.setHeader && typeof stream.abort === "function";
    }
    var nop = () => {
    };
    function eos(stream, options, callback) {
      var _options$readable, _options$writable;
      if (arguments.length === 2) {
        callback = options;
        options = kEmptyObject;
      } else if (options == null) {
        options = kEmptyObject;
      } else {
        validateObject(options, "options");
      }
      validateFunction(callback, "callback");
      validateAbortSignal(options.signal, "options.signal");
      callback = once(callback);
      if (isReadableStream(stream) || isWritableStream(stream)) {
        return eosWeb(stream, options, callback);
      }
      if (!isNodeStream(stream)) {
        throw new ERR_INVALID_ARG_TYPE("stream", ["ReadableStream", "WritableStream", "Stream"], stream);
      }
      const readable = (_options$readable = options.readable) !== null && _options$readable !== void 0 ? _options$readable : isReadableNodeStream(stream);
      const writable = (_options$writable = options.writable) !== null && _options$writable !== void 0 ? _options$writable : isWritableNodeStream(stream);
      const wState = stream._writableState;
      const rState = stream._readableState;
      const onlegacyfinish = () => {
        if (!stream.writable) {
          onfinish();
        }
      };
      let willEmitClose = _willEmitClose(stream) && isReadableNodeStream(stream) === readable && isWritableNodeStream(stream) === writable;
      let writableFinished = isWritableFinished(stream, false);
      const onfinish = () => {
        writableFinished = true;
        if (stream.destroyed) {
          willEmitClose = false;
        }
        if (willEmitClose && (!stream.readable || readable)) {
          return;
        }
        if (!readable || readableFinished) {
          callback.call(stream);
        }
      };
      let readableFinished = isReadableFinished(stream, false);
      const onend = () => {
        readableFinished = true;
        if (stream.destroyed) {
          willEmitClose = false;
        }
        if (willEmitClose && (!stream.writable || writable)) {
          return;
        }
        if (!writable || writableFinished) {
          callback.call(stream);
        }
      };
      const onerror = (err) => {
        callback.call(stream, err);
      };
      let closed = isClosed(stream);
      const onclose = () => {
        closed = true;
        const errored = isWritableErrored(stream) || isReadableErrored(stream);
        if (errored && typeof errored !== "boolean") {
          return callback.call(stream, errored);
        }
        if (readable && !readableFinished && isReadableNodeStream(stream, true)) {
          if (!isReadableFinished(stream, false)) return callback.call(stream, new ERR_STREAM_PREMATURE_CLOSE());
        }
        if (writable && !writableFinished) {
          if (!isWritableFinished(stream, false)) return callback.call(stream, new ERR_STREAM_PREMATURE_CLOSE());
        }
        callback.call(stream);
      };
      const onclosed = () => {
        closed = true;
        const errored = isWritableErrored(stream) || isReadableErrored(stream);
        if (errored && typeof errored !== "boolean") {
          return callback.call(stream, errored);
        }
        callback.call(stream);
      };
      const onrequest = () => {
        stream.req.on("finish", onfinish);
      };
      if (isRequest(stream)) {
        stream.on("complete", onfinish);
        if (!willEmitClose) {
          stream.on("abort", onclose);
        }
        if (stream.req) {
          onrequest();
        } else {
          stream.on("request", onrequest);
        }
      } else if (writable && !wState) {
        stream.on("end", onlegacyfinish);
        stream.on("close", onlegacyfinish);
      }
      if (!willEmitClose && typeof stream.aborted === "boolean") {
        stream.on("aborted", onclose);
      }
      stream.on("end", onend);
      stream.on("finish", onfinish);
      if (options.error !== false) {
        stream.on("error", onerror);
      }
      stream.on("close", onclose);
      if (closed) {
        process2.nextTick(onclose);
      } else if (wState !== null && wState !== void 0 && wState.errorEmitted || rState !== null && rState !== void 0 && rState.errorEmitted) {
        if (!willEmitClose) {
          process2.nextTick(onclosed);
        }
      } else if (!readable && (!willEmitClose || isReadable(stream)) && (writableFinished || isWritable(stream) === false)) {
        process2.nextTick(onclosed);
      } else if (!writable && (!willEmitClose || isWritable(stream)) && (readableFinished || isReadable(stream) === false)) {
        process2.nextTick(onclosed);
      } else if (rState && stream.req && stream.aborted) {
        process2.nextTick(onclosed);
      }
      const cleanup = () => {
        callback = nop;
        stream.removeListener("aborted", onclose);
        stream.removeListener("complete", onfinish);
        stream.removeListener("abort", onclose);
        stream.removeListener("request", onrequest);
        if (stream.req) stream.req.removeListener("finish", onfinish);
        stream.removeListener("end", onlegacyfinish);
        stream.removeListener("close", onlegacyfinish);
        stream.removeListener("finish", onfinish);
        stream.removeListener("end", onend);
        stream.removeListener("error", onerror);
        stream.removeListener("close", onclose);
      };
      if (options.signal && !closed) {
        const abort = () => {
          const endCallback = callback;
          cleanup();
          endCallback.call(
            stream,
            new AbortError(void 0, {
              cause: options.signal.reason
            })
          );
        };
        if (options.signal.aborted) {
          process2.nextTick(abort);
        } else {
          addAbortListener = addAbortListener || require_util().addAbortListener;
          const disposable = addAbortListener(options.signal, abort);
          const originalCallback = callback;
          callback = once((...args) => {
            disposable[SymbolDispose]();
            originalCallback.apply(stream, args);
          });
        }
      }
      return cleanup;
    }
    function eosWeb(stream, options, callback) {
      let isAborted = false;
      let abort = nop;
      if (options.signal) {
        abort = () => {
          isAborted = true;
          callback.call(
            stream,
            new AbortError(void 0, {
              cause: options.signal.reason
            })
          );
        };
        if (options.signal.aborted) {
          process2.nextTick(abort);
        } else {
          addAbortListener = addAbortListener || require_util().addAbortListener;
          const disposable = addAbortListener(options.signal, abort);
          const originalCallback = callback;
          callback = once((...args) => {
            disposable[SymbolDispose]();
            originalCallback.apply(stream, args);
          });
        }
      }
      const resolverFn = (...args) => {
        if (!isAborted) {
          process2.nextTick(() => callback.apply(stream, args));
        }
      };
      PromisePrototypeThen(stream[kIsClosedPromise].promise, resolverFn, resolverFn);
      return nop;
    }
    function finished(stream, opts) {
      var _opts;
      let autoCleanup = false;
      if (opts === null) {
        opts = kEmptyObject;
      }
      if ((_opts = opts) !== null && _opts !== void 0 && _opts.cleanup) {
        validateBoolean(opts.cleanup, "cleanup");
        autoCleanup = opts.cleanup;
      }
      return new Promise2((resolve, reject) => {
        const cleanup = eos(stream, opts, (err) => {
          if (autoCleanup) {
            cleanup();
          }
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
    module2.exports = eos;
    module2.exports.finished = finished;
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/destroy.js
var require_destroy = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/destroy.js"(exports2, module2) {
    "use strict";
    var process2 = require_process();
    var {
      aggregateTwoErrors,
      codes: { ERR_MULTIPLE_CALLBACK },
      AbortError
    } = require_errors();
    var { Symbol: Symbol2 } = require_primordials();
    var { kIsDestroyed, isDestroyed, isFinished, isServerRequest } = require_utils();
    var kDestroy = Symbol2("kDestroy");
    var kConstruct = Symbol2("kConstruct");
    function checkError(err, w, r) {
      if (err) {
        err.stack;
        if (w && !w.errored) {
          w.errored = err;
        }
        if (r && !r.errored) {
          r.errored = err;
        }
      }
    }
    function destroy(err, cb) {
      const r = this._readableState;
      const w = this._writableState;
      const s = w || r;
      if (w !== null && w !== void 0 && w.destroyed || r !== null && r !== void 0 && r.destroyed) {
        if (typeof cb === "function") {
          cb();
        }
        return this;
      }
      checkError(err, w, r);
      if (w) {
        w.destroyed = true;
      }
      if (r) {
        r.destroyed = true;
      }
      if (!s.constructed) {
        this.once(kDestroy, function(er) {
          _destroy(this, aggregateTwoErrors(er, err), cb);
        });
      } else {
        _destroy(this, err, cb);
      }
      return this;
    }
    function _destroy(self, err, cb) {
      let called = false;
      function onDestroy(err2) {
        if (called) {
          return;
        }
        called = true;
        const r = self._readableState;
        const w = self._writableState;
        checkError(err2, w, r);
        if (w) {
          w.closed = true;
        }
        if (r) {
          r.closed = true;
        }
        if (typeof cb === "function") {
          cb(err2);
        }
        if (err2) {
          process2.nextTick(emitErrorCloseNT, self, err2);
        } else {
          process2.nextTick(emitCloseNT, self);
        }
      }
      try {
        self._destroy(err || null, onDestroy);
      } catch (err2) {
        onDestroy(err2);
      }
    }
    function emitErrorCloseNT(self, err) {
      emitErrorNT(self, err);
      emitCloseNT(self);
    }
    function emitCloseNT(self) {
      const r = self._readableState;
      const w = self._writableState;
      if (w) {
        w.closeEmitted = true;
      }
      if (r) {
        r.closeEmitted = true;
      }
      if (w !== null && w !== void 0 && w.emitClose || r !== null && r !== void 0 && r.emitClose) {
        self.emit("close");
      }
    }
    function emitErrorNT(self, err) {
      const r = self._readableState;
      const w = self._writableState;
      if (w !== null && w !== void 0 && w.errorEmitted || r !== null && r !== void 0 && r.errorEmitted) {
        return;
      }
      if (w) {
        w.errorEmitted = true;
      }
      if (r) {
        r.errorEmitted = true;
      }
      self.emit("error", err);
    }
    function undestroy() {
      const r = this._readableState;
      const w = this._writableState;
      if (r) {
        r.constructed = true;
        r.closed = false;
        r.closeEmitted = false;
        r.destroyed = false;
        r.errored = null;
        r.errorEmitted = false;
        r.reading = false;
        r.ended = r.readable === false;
        r.endEmitted = r.readable === false;
      }
      if (w) {
        w.constructed = true;
        w.destroyed = false;
        w.closed = false;
        w.closeEmitted = false;
        w.errored = null;
        w.errorEmitted = false;
        w.finalCalled = false;
        w.prefinished = false;
        w.ended = w.writable === false;
        w.ending = w.writable === false;
        w.finished = w.writable === false;
      }
    }
    function errorOrDestroy(stream, err, sync) {
      const r = stream._readableState;
      const w = stream._writableState;
      if (w !== null && w !== void 0 && w.destroyed || r !== null && r !== void 0 && r.destroyed) {
        return this;
      }
      if (r !== null && r !== void 0 && r.autoDestroy || w !== null && w !== void 0 && w.autoDestroy)
        stream.destroy(err);
      else if (err) {
        err.stack;
        if (w && !w.errored) {
          w.errored = err;
        }
        if (r && !r.errored) {
          r.errored = err;
        }
        if (sync) {
          process2.nextTick(emitErrorNT, stream, err);
        } else {
          emitErrorNT(stream, err);
        }
      }
    }
    function construct(stream, cb) {
      if (typeof stream._construct !== "function") {
        return;
      }
      const r = stream._readableState;
      const w = stream._writableState;
      if (r) {
        r.constructed = false;
      }
      if (w) {
        w.constructed = false;
      }
      stream.once(kConstruct, cb);
      if (stream.listenerCount(kConstruct) > 1) {
        return;
      }
      process2.nextTick(constructNT, stream);
    }
    function constructNT(stream) {
      let called = false;
      function onConstruct(err) {
        if (called) {
          errorOrDestroy(stream, err !== null && err !== void 0 ? err : new ERR_MULTIPLE_CALLBACK());
          return;
        }
        called = true;
        const r = stream._readableState;
        const w = stream._writableState;
        const s = w || r;
        if (r) {
          r.constructed = true;
        }
        if (w) {
          w.constructed = true;
        }
        if (s.destroyed) {
          stream.emit(kDestroy, err);
        } else if (err) {
          errorOrDestroy(stream, err, true);
        } else {
          process2.nextTick(emitConstructNT, stream);
        }
      }
      try {
        stream._construct((err) => {
          process2.nextTick(onConstruct, err);
        });
      } catch (err) {
        process2.nextTick(onConstruct, err);
      }
    }
    function emitConstructNT(stream) {
      stream.emit(kConstruct);
    }
    function isRequest(stream) {
      return (stream === null || stream === void 0 ? void 0 : stream.setHeader) && typeof stream.abort === "function";
    }
    function emitCloseLegacy(stream) {
      stream.emit("close");
    }
    function emitErrorCloseLegacy(stream, err) {
      stream.emit("error", err);
      process2.nextTick(emitCloseLegacy, stream);
    }
    function destroyer(stream, err) {
      if (!stream || isDestroyed(stream)) {
        return;
      }
      if (!err && !isFinished(stream)) {
        err = new AbortError();
      }
      if (isServerRequest(stream)) {
        stream.socket = null;
        stream.destroy(err);
      } else if (isRequest(stream)) {
        stream.abort();
      } else if (isRequest(stream.req)) {
        stream.req.abort();
      } else if (typeof stream.destroy === "function") {
        stream.destroy(err);
      } else if (typeof stream.close === "function") {
        stream.close();
      } else if (err) {
        process2.nextTick(emitErrorCloseLegacy, stream, err);
      } else {
        process2.nextTick(emitCloseLegacy, stream);
      }
      if (!stream.destroyed) {
        stream[kIsDestroyed] = true;
      }
    }
    module2.exports = {
      construct,
      destroyer,
      destroy,
      undestroy,
      errorOrDestroy
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/legacy.js
var require_legacy = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/legacy.js"(exports2, module2) {
    "use strict";
    var { ArrayIsArray, ObjectSetPrototypeOf } = require_primordials();
    var { EventEmitter: EE } = require("events");
    function Stream(opts) {
      EE.call(this, opts);
    }
    ObjectSetPrototypeOf(Stream.prototype, EE.prototype);
    ObjectSetPrototypeOf(Stream, EE);
    Stream.prototype.pipe = function(dest, options) {
      const source = this;
      function ondata(chunk) {
        if (dest.writable && dest.write(chunk) === false && source.pause) {
          source.pause();
        }
      }
      source.on("data", ondata);
      function ondrain() {
        if (source.readable && source.resume) {
          source.resume();
        }
      }
      dest.on("drain", ondrain);
      if (!dest._isStdio && (!options || options.end !== false)) {
        source.on("end", onend);
        source.on("close", onclose);
      }
      let didOnEnd = false;
      function onend() {
        if (didOnEnd) return;
        didOnEnd = true;
        dest.end();
      }
      function onclose() {
        if (didOnEnd) return;
        didOnEnd = true;
        if (typeof dest.destroy === "function") dest.destroy();
      }
      function onerror(er) {
        cleanup();
        if (EE.listenerCount(this, "error") === 0) {
          this.emit("error", er);
        }
      }
      prependListener(source, "error", onerror);
      prependListener(dest, "error", onerror);
      function cleanup() {
        source.removeListener("data", ondata);
        dest.removeListener("drain", ondrain);
        source.removeListener("end", onend);
        source.removeListener("close", onclose);
        source.removeListener("error", onerror);
        dest.removeListener("error", onerror);
        source.removeListener("end", cleanup);
        source.removeListener("close", cleanup);
        dest.removeListener("close", cleanup);
      }
      source.on("end", cleanup);
      source.on("close", cleanup);
      dest.on("close", cleanup);
      dest.emit("pipe", source);
      return dest;
    };
    function prependListener(emitter, event, fn) {
      if (typeof emitter.prependListener === "function") return emitter.prependListener(event, fn);
      if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);
      else if (ArrayIsArray(emitter._events[event])) emitter._events[event].unshift(fn);
      else emitter._events[event] = [fn, emitter._events[event]];
    }
    module2.exports = {
      Stream,
      prependListener
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/add-abort-signal.js
var require_add_abort_signal = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/add-abort-signal.js"(exports2, module2) {
    "use strict";
    var { SymbolDispose } = require_primordials();
    var { AbortError, codes } = require_errors();
    var { isNodeStream, isWebStream, kControllerErrorFunction } = require_utils();
    var eos = require_end_of_stream();
    var { ERR_INVALID_ARG_TYPE } = codes;
    var addAbortListener;
    var validateAbortSignal = (signal, name) => {
      if (typeof signal !== "object" || !("aborted" in signal)) {
        throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
      }
    };
    module2.exports.addAbortSignal = function addAbortSignal(signal, stream) {
      validateAbortSignal(signal, "signal");
      if (!isNodeStream(stream) && !isWebStream(stream)) {
        throw new ERR_INVALID_ARG_TYPE("stream", ["ReadableStream", "WritableStream", "Stream"], stream);
      }
      return module2.exports.addAbortSignalNoValidate(signal, stream);
    };
    module2.exports.addAbortSignalNoValidate = function(signal, stream) {
      if (typeof signal !== "object" || !("aborted" in signal)) {
        return stream;
      }
      const onAbort = isNodeStream(stream) ? () => {
        stream.destroy(
          new AbortError(void 0, {
            cause: signal.reason
          })
        );
      } : () => {
        stream[kControllerErrorFunction](
          new AbortError(void 0, {
            cause: signal.reason
          })
        );
      };
      if (signal.aborted) {
        onAbort();
      } else {
        addAbortListener = addAbortListener || require_util().addAbortListener;
        const disposable = addAbortListener(signal, onAbort);
        eos(stream, disposable[SymbolDispose]);
      }
      return stream;
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/buffer_list.js
var require_buffer_list = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/buffer_list.js"(exports2, module2) {
    "use strict";
    var { StringPrototypeSlice, SymbolIterator, TypedArrayPrototypeSet, Uint8Array: Uint8Array2 } = require_primordials();
    var { Buffer: Buffer2 } = require("buffer");
    var { inspect } = require_util();
    module2.exports = class BufferList {
      constructor() {
        this.head = null;
        this.tail = null;
        this.length = 0;
      }
      push(v) {
        const entry = {
          data: v,
          next: null
        };
        if (this.length > 0) this.tail.next = entry;
        else this.head = entry;
        this.tail = entry;
        ++this.length;
      }
      unshift(v) {
        const entry = {
          data: v,
          next: this.head
        };
        if (this.length === 0) this.tail = entry;
        this.head = entry;
        ++this.length;
      }
      shift() {
        if (this.length === 0) return;
        const ret = this.head.data;
        if (this.length === 1) this.head = this.tail = null;
        else this.head = this.head.next;
        --this.length;
        return ret;
      }
      clear() {
        this.head = this.tail = null;
        this.length = 0;
      }
      join(s) {
        if (this.length === 0) return "";
        let p = this.head;
        let ret = "" + p.data;
        while ((p = p.next) !== null) ret += s + p.data;
        return ret;
      }
      concat(n) {
        if (this.length === 0) return Buffer2.alloc(0);
        const ret = Buffer2.allocUnsafe(n >>> 0);
        let p = this.head;
        let i = 0;
        while (p) {
          TypedArrayPrototypeSet(ret, p.data, i);
          i += p.data.length;
          p = p.next;
        }
        return ret;
      }
      // Consumes a specified amount of bytes or characters from the buffered data.
      consume(n, hasStrings) {
        const data = this.head.data;
        if (n < data.length) {
          const slice = data.slice(0, n);
          this.head.data = data.slice(n);
          return slice;
        }
        if (n === data.length) {
          return this.shift();
        }
        return hasStrings ? this._getString(n) : this._getBuffer(n);
      }
      first() {
        return this.head.data;
      }
      *[SymbolIterator]() {
        for (let p = this.head; p; p = p.next) {
          yield p.data;
        }
      }
      // Consumes a specified amount of characters from the buffered data.
      _getString(n) {
        let ret = "";
        let p = this.head;
        let c = 0;
        do {
          const str = p.data;
          if (n > str.length) {
            ret += str;
            n -= str.length;
          } else {
            if (n === str.length) {
              ret += str;
              ++c;
              if (p.next) this.head = p.next;
              else this.head = this.tail = null;
            } else {
              ret += StringPrototypeSlice(str, 0, n);
              this.head = p;
              p.data = StringPrototypeSlice(str, n);
            }
            break;
          }
          ++c;
        } while ((p = p.next) !== null);
        this.length -= c;
        return ret;
      }
      // Consumes a specified amount of bytes from the buffered data.
      _getBuffer(n) {
        const ret = Buffer2.allocUnsafe(n);
        const retLen = n;
        let p = this.head;
        let c = 0;
        do {
          const buf = p.data;
          if (n > buf.length) {
            TypedArrayPrototypeSet(ret, buf, retLen - n);
            n -= buf.length;
          } else {
            if (n === buf.length) {
              TypedArrayPrototypeSet(ret, buf, retLen - n);
              ++c;
              if (p.next) this.head = p.next;
              else this.head = this.tail = null;
            } else {
              TypedArrayPrototypeSet(ret, new Uint8Array2(buf.buffer, buf.byteOffset, n), retLen - n);
              this.head = p;
              p.data = buf.slice(n);
            }
            break;
          }
          ++c;
        } while ((p = p.next) !== null);
        this.length -= c;
        return ret;
      }
      // Make sure the linked list only shows the minimal necessary information.
      [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")](_, options) {
        return inspect(this, {
          ...options,
          // Only inspect one level.
          depth: 0,
          // It should not recurse.
          customInspect: false
        });
      }
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/state.js
var require_state = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/state.js"(exports2, module2) {
    "use strict";
    var { MathFloor, NumberIsInteger } = require_primordials();
    var { validateInteger } = require_validators();
    var { ERR_INVALID_ARG_VALUE } = require_errors().codes;
    var defaultHighWaterMarkBytes = 16 * 1024;
    var defaultHighWaterMarkObjectMode = 16;
    function highWaterMarkFrom(options, isDuplex, duplexKey) {
      return options.highWaterMark != null ? options.highWaterMark : isDuplex ? options[duplexKey] : null;
    }
    function getDefaultHighWaterMark(objectMode) {
      return objectMode ? defaultHighWaterMarkObjectMode : defaultHighWaterMarkBytes;
    }
    function setDefaultHighWaterMark(objectMode, value) {
      validateInteger(value, "value", 0);
      if (objectMode) {
        defaultHighWaterMarkObjectMode = value;
      } else {
        defaultHighWaterMarkBytes = value;
      }
    }
    function getHighWaterMark(state, options, duplexKey, isDuplex) {
      const hwm = highWaterMarkFrom(options, isDuplex, duplexKey);
      if (hwm != null) {
        if (!NumberIsInteger(hwm) || hwm < 0) {
          const name = isDuplex ? `options.${duplexKey}` : "options.highWaterMark";
          throw new ERR_INVALID_ARG_VALUE(name, hwm);
        }
        return MathFloor(hwm);
      }
      return getDefaultHighWaterMark(state.objectMode);
    }
    module2.exports = {
      getHighWaterMark,
      getDefaultHighWaterMark,
      setDefaultHighWaterMark
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/safe-buffer/index.js
var require_safe_buffer = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/safe-buffer/index.js"(exports2, module2) {
    var buffer = require("buffer");
    var Buffer2 = buffer.Buffer;
    function copyProps(src, dst) {
      for (var key in src) {
        dst[key] = src[key];
      }
    }
    if (Buffer2.from && Buffer2.alloc && Buffer2.allocUnsafe && Buffer2.allocUnsafeSlow) {
      module2.exports = buffer;
    } else {
      copyProps(buffer, exports2);
      exports2.Buffer = SafeBuffer;
    }
    function SafeBuffer(arg, encodingOrOffset, length) {
      return Buffer2(arg, encodingOrOffset, length);
    }
    SafeBuffer.prototype = Object.create(Buffer2.prototype);
    copyProps(Buffer2, SafeBuffer);
    SafeBuffer.from = function(arg, encodingOrOffset, length) {
      if (typeof arg === "number") {
        throw new TypeError("Argument must not be a number");
      }
      return Buffer2(arg, encodingOrOffset, length);
    };
    SafeBuffer.alloc = function(size, fill, encoding) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      var buf = Buffer2(size);
      if (fill !== void 0) {
        if (typeof encoding === "string") {
          buf.fill(fill, encoding);
        } else {
          buf.fill(fill);
        }
      } else {
        buf.fill(0);
      }
      return buf;
    };
    SafeBuffer.allocUnsafe = function(size) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      return Buffer2(size);
    };
    SafeBuffer.allocUnsafeSlow = function(size) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      return buffer.SlowBuffer(size);
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/string_decoder/lib/string_decoder.js
var require_string_decoder = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/string_decoder/lib/string_decoder.js"(exports2) {
    "use strict";
    var Buffer2 = require_safe_buffer().Buffer;
    var isEncoding = Buffer2.isEncoding || function(encoding) {
      encoding = "" + encoding;
      switch (encoding && encoding.toLowerCase()) {
        case "hex":
        case "utf8":
        case "utf-8":
        case "ascii":
        case "binary":
        case "base64":
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
        case "raw":
          return true;
        default:
          return false;
      }
    };
    function _normalizeEncoding(enc) {
      if (!enc) return "utf8";
      var retried;
      while (true) {
        switch (enc) {
          case "utf8":
          case "utf-8":
            return "utf8";
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return "utf16le";
          case "latin1":
          case "binary":
            return "latin1";
          case "base64":
          case "ascii":
          case "hex":
            return enc;
          default:
            if (retried) return;
            enc = ("" + enc).toLowerCase();
            retried = true;
        }
      }
    }
    function normalizeEncoding(enc) {
      var nenc = _normalizeEncoding(enc);
      if (typeof nenc !== "string" && (Buffer2.isEncoding === isEncoding || !isEncoding(enc))) throw new Error("Unknown encoding: " + enc);
      return nenc || enc;
    }
    exports2.StringDecoder = StringDecoder;
    function StringDecoder(encoding) {
      this.encoding = normalizeEncoding(encoding);
      var nb;
      switch (this.encoding) {
        case "utf16le":
          this.text = utf16Text;
          this.end = utf16End;
          nb = 4;
          break;
        case "utf8":
          this.fillLast = utf8FillLast;
          nb = 4;
          break;
        case "base64":
          this.text = base64Text;
          this.end = base64End;
          nb = 3;
          break;
        default:
          this.write = simpleWrite;
          this.end = simpleEnd;
          return;
      }
      this.lastNeed = 0;
      this.lastTotal = 0;
      this.lastChar = Buffer2.allocUnsafe(nb);
    }
    StringDecoder.prototype.write = function(buf) {
      if (buf.length === 0) return "";
      var r;
      var i;
      if (this.lastNeed) {
        r = this.fillLast(buf);
        if (r === void 0) return "";
        i = this.lastNeed;
        this.lastNeed = 0;
      } else {
        i = 0;
      }
      if (i < buf.length) return r ? r + this.text(buf, i) : this.text(buf, i);
      return r || "";
    };
    StringDecoder.prototype.end = utf8End;
    StringDecoder.prototype.text = utf8Text;
    StringDecoder.prototype.fillLast = function(buf) {
      if (this.lastNeed <= buf.length) {
        buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
        return this.lastChar.toString(this.encoding, 0, this.lastTotal);
      }
      buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
      this.lastNeed -= buf.length;
    };
    function utf8CheckByte(byte) {
      if (byte <= 127) return 0;
      else if (byte >> 5 === 6) return 2;
      else if (byte >> 4 === 14) return 3;
      else if (byte >> 3 === 30) return 4;
      return byte >> 6 === 2 ? -1 : -2;
    }
    function utf8CheckIncomplete(self, buf, i) {
      var j = buf.length - 1;
      if (j < i) return 0;
      var nb = utf8CheckByte(buf[j]);
      if (nb >= 0) {
        if (nb > 0) self.lastNeed = nb - 1;
        return nb;
      }
      if (--j < i || nb === -2) return 0;
      nb = utf8CheckByte(buf[j]);
      if (nb >= 0) {
        if (nb > 0) self.lastNeed = nb - 2;
        return nb;
      }
      if (--j < i || nb === -2) return 0;
      nb = utf8CheckByte(buf[j]);
      if (nb >= 0) {
        if (nb > 0) {
          if (nb === 2) nb = 0;
          else self.lastNeed = nb - 3;
        }
        return nb;
      }
      return 0;
    }
    function utf8CheckExtraBytes(self, buf, p) {
      if ((buf[0] & 192) !== 128) {
        self.lastNeed = 0;
        return "\uFFFD";
      }
      if (self.lastNeed > 1 && buf.length > 1) {
        if ((buf[1] & 192) !== 128) {
          self.lastNeed = 1;
          return "\uFFFD";
        }
        if (self.lastNeed > 2 && buf.length > 2) {
          if ((buf[2] & 192) !== 128) {
            self.lastNeed = 2;
            return "\uFFFD";
          }
        }
      }
    }
    function utf8FillLast(buf) {
      var p = this.lastTotal - this.lastNeed;
      var r = utf8CheckExtraBytes(this, buf, p);
      if (r !== void 0) return r;
      if (this.lastNeed <= buf.length) {
        buf.copy(this.lastChar, p, 0, this.lastNeed);
        return this.lastChar.toString(this.encoding, 0, this.lastTotal);
      }
      buf.copy(this.lastChar, p, 0, buf.length);
      this.lastNeed -= buf.length;
    }
    function utf8Text(buf, i) {
      var total = utf8CheckIncomplete(this, buf, i);
      if (!this.lastNeed) return buf.toString("utf8", i);
      this.lastTotal = total;
      var end = buf.length - (total - this.lastNeed);
      buf.copy(this.lastChar, 0, end);
      return buf.toString("utf8", i, end);
    }
    function utf8End(buf) {
      var r = buf && buf.length ? this.write(buf) : "";
      if (this.lastNeed) return r + "\uFFFD";
      return r;
    }
    function utf16Text(buf, i) {
      if ((buf.length - i) % 2 === 0) {
        var r = buf.toString("utf16le", i);
        if (r) {
          var c = r.charCodeAt(r.length - 1);
          if (c >= 55296 && c <= 56319) {
            this.lastNeed = 2;
            this.lastTotal = 4;
            this.lastChar[0] = buf[buf.length - 2];
            this.lastChar[1] = buf[buf.length - 1];
            return r.slice(0, -1);
          }
        }
        return r;
      }
      this.lastNeed = 1;
      this.lastTotal = 2;
      this.lastChar[0] = buf[buf.length - 1];
      return buf.toString("utf16le", i, buf.length - 1);
    }
    function utf16End(buf) {
      var r = buf && buf.length ? this.write(buf) : "";
      if (this.lastNeed) {
        var end = this.lastTotal - this.lastNeed;
        return r + this.lastChar.toString("utf16le", 0, end);
      }
      return r;
    }
    function base64Text(buf, i) {
      var n = (buf.length - i) % 3;
      if (n === 0) return buf.toString("base64", i);
      this.lastNeed = 3 - n;
      this.lastTotal = 3;
      if (n === 1) {
        this.lastChar[0] = buf[buf.length - 1];
      } else {
        this.lastChar[0] = buf[buf.length - 2];
        this.lastChar[1] = buf[buf.length - 1];
      }
      return buf.toString("base64", i, buf.length - n);
    }
    function base64End(buf) {
      var r = buf && buf.length ? this.write(buf) : "";
      if (this.lastNeed) return r + this.lastChar.toString("base64", 0, 3 - this.lastNeed);
      return r;
    }
    function simpleWrite(buf) {
      return buf.toString(this.encoding);
    }
    function simpleEnd(buf) {
      return buf && buf.length ? this.write(buf) : "";
    }
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/from.js
var require_from = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/from.js"(exports2, module2) {
    "use strict";
    var process2 = require_process();
    var { PromisePrototypeThen, SymbolAsyncIterator, SymbolIterator } = require_primordials();
    var { Buffer: Buffer2 } = require("buffer");
    var { ERR_INVALID_ARG_TYPE, ERR_STREAM_NULL_VALUES } = require_errors().codes;
    function from(Readable, iterable, opts) {
      let iterator;
      if (typeof iterable === "string" || iterable instanceof Buffer2) {
        return new Readable({
          objectMode: true,
          ...opts,
          read() {
            this.push(iterable);
            this.push(null);
          }
        });
      }
      let isAsync;
      if (iterable && iterable[SymbolAsyncIterator]) {
        isAsync = true;
        iterator = iterable[SymbolAsyncIterator]();
      } else if (iterable && iterable[SymbolIterator]) {
        isAsync = false;
        iterator = iterable[SymbolIterator]();
      } else {
        throw new ERR_INVALID_ARG_TYPE("iterable", ["Iterable"], iterable);
      }
      const readable = new Readable({
        objectMode: true,
        highWaterMark: 1,
        // TODO(ronag): What options should be allowed?
        ...opts
      });
      let reading = false;
      readable._read = function() {
        if (!reading) {
          reading = true;
          next();
        }
      };
      readable._destroy = function(error, cb) {
        PromisePrototypeThen(
          close(error),
          () => process2.nextTick(cb, error),
          // nextTick is here in case cb throws
          (e) => process2.nextTick(cb, e || error)
        );
      };
      async function close(error) {
        const hadError = error !== void 0 && error !== null;
        const hasThrow = typeof iterator.throw === "function";
        if (hadError && hasThrow) {
          const { value, done } = await iterator.throw(error);
          await value;
          if (done) {
            return;
          }
        }
        if (typeof iterator.return === "function") {
          const { value } = await iterator.return();
          await value;
        }
      }
      async function next() {
        for (; ; ) {
          try {
            const { value, done } = isAsync ? await iterator.next() : iterator.next();
            if (done) {
              readable.push(null);
            } else {
              const res = value && typeof value.then === "function" ? await value : value;
              if (res === null) {
                reading = false;
                throw new ERR_STREAM_NULL_VALUES();
              } else if (readable.push(res)) {
                continue;
              } else {
                reading = false;
              }
            }
          } catch (err) {
            readable.destroy(err);
          }
          break;
        }
      }
      return readable;
    }
    module2.exports = from;
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/readable.js
var require_readable = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/readable.js"(exports2, module2) {
    "use strict";
    var process2 = require_process();
    var {
      ArrayPrototypeIndexOf,
      NumberIsInteger,
      NumberIsNaN,
      NumberParseInt,
      ObjectDefineProperties,
      ObjectKeys,
      ObjectSetPrototypeOf,
      Promise: Promise2,
      SafeSet,
      SymbolAsyncDispose,
      SymbolAsyncIterator,
      Symbol: Symbol2
    } = require_primordials();
    module2.exports = Readable;
    Readable.ReadableState = ReadableState;
    var { EventEmitter: EE } = require("events");
    var { Stream, prependListener } = require_legacy();
    var { Buffer: Buffer2 } = require("buffer");
    var { addAbortSignal } = require_add_abort_signal();
    var eos = require_end_of_stream();
    var debug = require_util().debuglog("stream", (fn) => {
      debug = fn;
    });
    var BufferList = require_buffer_list();
    var destroyImpl = require_destroy();
    var { getHighWaterMark, getDefaultHighWaterMark } = require_state();
    var {
      aggregateTwoErrors,
      codes: {
        ERR_INVALID_ARG_TYPE,
        ERR_METHOD_NOT_IMPLEMENTED,
        ERR_OUT_OF_RANGE,
        ERR_STREAM_PUSH_AFTER_EOF,
        ERR_STREAM_UNSHIFT_AFTER_END_EVENT
      },
      AbortError
    } = require_errors();
    var { validateObject } = require_validators();
    var kPaused = Symbol2("kPaused");
    var { StringDecoder } = require_string_decoder();
    var from = require_from();
    ObjectSetPrototypeOf(Readable.prototype, Stream.prototype);
    ObjectSetPrototypeOf(Readable, Stream);
    var nop = () => {
    };
    var { errorOrDestroy } = destroyImpl;
    var kObjectMode = 1 << 0;
    var kEnded = 1 << 1;
    var kEndEmitted = 1 << 2;
    var kReading = 1 << 3;
    var kConstructed = 1 << 4;
    var kSync = 1 << 5;
    var kNeedReadable = 1 << 6;
    var kEmittedReadable = 1 << 7;
    var kReadableListening = 1 << 8;
    var kResumeScheduled = 1 << 9;
    var kErrorEmitted = 1 << 10;
    var kEmitClose = 1 << 11;
    var kAutoDestroy = 1 << 12;
    var kDestroyed = 1 << 13;
    var kClosed = 1 << 14;
    var kCloseEmitted = 1 << 15;
    var kMultiAwaitDrain = 1 << 16;
    var kReadingMore = 1 << 17;
    var kDataEmitted = 1 << 18;
    function makeBitMapDescriptor(bit) {
      return {
        enumerable: false,
        get() {
          return (this.state & bit) !== 0;
        },
        set(value) {
          if (value) this.state |= bit;
          else this.state &= ~bit;
        }
      };
    }
    ObjectDefineProperties(ReadableState.prototype, {
      objectMode: makeBitMapDescriptor(kObjectMode),
      ended: makeBitMapDescriptor(kEnded),
      endEmitted: makeBitMapDescriptor(kEndEmitted),
      reading: makeBitMapDescriptor(kReading),
      // Stream is still being constructed and cannot be
      // destroyed until construction finished or failed.
      // Async construction is opt in, therefore we start as
      // constructed.
      constructed: makeBitMapDescriptor(kConstructed),
      // A flag to be able to tell if the event 'readable'/'data' is emitted
      // immediately, or on a later tick.  We set this to true at first, because
      // any actions that shouldn't happen until "later" should generally also
      // not happen before the first read call.
      sync: makeBitMapDescriptor(kSync),
      // Whenever we return null, then we set a flag to say
      // that we're awaiting a 'readable' event emission.
      needReadable: makeBitMapDescriptor(kNeedReadable),
      emittedReadable: makeBitMapDescriptor(kEmittedReadable),
      readableListening: makeBitMapDescriptor(kReadableListening),
      resumeScheduled: makeBitMapDescriptor(kResumeScheduled),
      // True if the error was already emitted and should not be thrown again.
      errorEmitted: makeBitMapDescriptor(kErrorEmitted),
      emitClose: makeBitMapDescriptor(kEmitClose),
      autoDestroy: makeBitMapDescriptor(kAutoDestroy),
      // Has it been destroyed.
      destroyed: makeBitMapDescriptor(kDestroyed),
      // Indicates whether the stream has finished destroying.
      closed: makeBitMapDescriptor(kClosed),
      // True if close has been emitted or would have been emitted
      // depending on emitClose.
      closeEmitted: makeBitMapDescriptor(kCloseEmitted),
      multiAwaitDrain: makeBitMapDescriptor(kMultiAwaitDrain),
      // If true, a maybeReadMore has been scheduled.
      readingMore: makeBitMapDescriptor(kReadingMore),
      dataEmitted: makeBitMapDescriptor(kDataEmitted)
    });
    function ReadableState(options, stream, isDuplex) {
      if (typeof isDuplex !== "boolean") isDuplex = stream instanceof require_duplex();
      this.state = kEmitClose | kAutoDestroy | kConstructed | kSync;
      if (options && options.objectMode) this.state |= kObjectMode;
      if (isDuplex && options && options.readableObjectMode) this.state |= kObjectMode;
      this.highWaterMark = options ? getHighWaterMark(this, options, "readableHighWaterMark", isDuplex) : getDefaultHighWaterMark(false);
      this.buffer = new BufferList();
      this.length = 0;
      this.pipes = [];
      this.flowing = null;
      this[kPaused] = null;
      if (options && options.emitClose === false) this.state &= ~kEmitClose;
      if (options && options.autoDestroy === false) this.state &= ~kAutoDestroy;
      this.errored = null;
      this.defaultEncoding = options && options.defaultEncoding || "utf8";
      this.awaitDrainWriters = null;
      this.decoder = null;
      this.encoding = null;
      if (options && options.encoding) {
        this.decoder = new StringDecoder(options.encoding);
        this.encoding = options.encoding;
      }
    }
    function Readable(options) {
      if (!(this instanceof Readable)) return new Readable(options);
      const isDuplex = this instanceof require_duplex();
      this._readableState = new ReadableState(options, this, isDuplex);
      if (options) {
        if (typeof options.read === "function") this._read = options.read;
        if (typeof options.destroy === "function") this._destroy = options.destroy;
        if (typeof options.construct === "function") this._construct = options.construct;
        if (options.signal && !isDuplex) addAbortSignal(options.signal, this);
      }
      Stream.call(this, options);
      destroyImpl.construct(this, () => {
        if (this._readableState.needReadable) {
          maybeReadMore(this, this._readableState);
        }
      });
    }
    Readable.prototype.destroy = destroyImpl.destroy;
    Readable.prototype._undestroy = destroyImpl.undestroy;
    Readable.prototype._destroy = function(err, cb) {
      cb(err);
    };
    Readable.prototype[EE.captureRejectionSymbol] = function(err) {
      this.destroy(err);
    };
    Readable.prototype[SymbolAsyncDispose] = function() {
      let error;
      if (!this.destroyed) {
        error = this.readableEnded ? null : new AbortError();
        this.destroy(error);
      }
      return new Promise2((resolve, reject) => eos(this, (err) => err && err !== error ? reject(err) : resolve(null)));
    };
    Readable.prototype.push = function(chunk, encoding) {
      return readableAddChunk(this, chunk, encoding, false);
    };
    Readable.prototype.unshift = function(chunk, encoding) {
      return readableAddChunk(this, chunk, encoding, true);
    };
    function readableAddChunk(stream, chunk, encoding, addToFront) {
      debug("readableAddChunk", chunk);
      const state = stream._readableState;
      let err;
      if ((state.state & kObjectMode) === 0) {
        if (typeof chunk === "string") {
          encoding = encoding || state.defaultEncoding;
          if (state.encoding !== encoding) {
            if (addToFront && state.encoding) {
              chunk = Buffer2.from(chunk, encoding).toString(state.encoding);
            } else {
              chunk = Buffer2.from(chunk, encoding);
              encoding = "";
            }
          }
        } else if (chunk instanceof Buffer2) {
          encoding = "";
        } else if (Stream._isUint8Array(chunk)) {
          chunk = Stream._uint8ArrayToBuffer(chunk);
          encoding = "";
        } else if (chunk != null) {
          err = new ERR_INVALID_ARG_TYPE("chunk", ["string", "Buffer", "Uint8Array"], chunk);
        }
      }
      if (err) {
        errorOrDestroy(stream, err);
      } else if (chunk === null) {
        state.state &= ~kReading;
        onEofChunk(stream, state);
      } else if ((state.state & kObjectMode) !== 0 || chunk && chunk.length > 0) {
        if (addToFront) {
          if ((state.state & kEndEmitted) !== 0) errorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT());
          else if (state.destroyed || state.errored) return false;
          else addChunk(stream, state, chunk, true);
        } else if (state.ended) {
          errorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF());
        } else if (state.destroyed || state.errored) {
          return false;
        } else {
          state.state &= ~kReading;
          if (state.decoder && !encoding) {
            chunk = state.decoder.write(chunk);
            if (state.objectMode || chunk.length !== 0) addChunk(stream, state, chunk, false);
            else maybeReadMore(stream, state);
          } else {
            addChunk(stream, state, chunk, false);
          }
        }
      } else if (!addToFront) {
        state.state &= ~kReading;
        maybeReadMore(stream, state);
      }
      return !state.ended && (state.length < state.highWaterMark || state.length === 0);
    }
    function addChunk(stream, state, chunk, addToFront) {
      if (state.flowing && state.length === 0 && !state.sync && stream.listenerCount("data") > 0) {
        if ((state.state & kMultiAwaitDrain) !== 0) {
          state.awaitDrainWriters.clear();
        } else {
          state.awaitDrainWriters = null;
        }
        state.dataEmitted = true;
        stream.emit("data", chunk);
      } else {
        state.length += state.objectMode ? 1 : chunk.length;
        if (addToFront) state.buffer.unshift(chunk);
        else state.buffer.push(chunk);
        if ((state.state & kNeedReadable) !== 0) emitReadable(stream);
      }
      maybeReadMore(stream, state);
    }
    Readable.prototype.isPaused = function() {
      const state = this._readableState;
      return state[kPaused] === true || state.flowing === false;
    };
    Readable.prototype.setEncoding = function(enc) {
      const decoder = new StringDecoder(enc);
      this._readableState.decoder = decoder;
      this._readableState.encoding = this._readableState.decoder.encoding;
      const buffer = this._readableState.buffer;
      let content = "";
      for (const data of buffer) {
        content += decoder.write(data);
      }
      buffer.clear();
      if (content !== "") buffer.push(content);
      this._readableState.length = content.length;
      return this;
    };
    var MAX_HWM = 1073741824;
    function computeNewHighWaterMark(n) {
      if (n > MAX_HWM) {
        throw new ERR_OUT_OF_RANGE("size", "<= 1GiB", n);
      } else {
        n--;
        n |= n >>> 1;
        n |= n >>> 2;
        n |= n >>> 4;
        n |= n >>> 8;
        n |= n >>> 16;
        n++;
      }
      return n;
    }
    function howMuchToRead(n, state) {
      if (n <= 0 || state.length === 0 && state.ended) return 0;
      if ((state.state & kObjectMode) !== 0) return 1;
      if (NumberIsNaN(n)) {
        if (state.flowing && state.length) return state.buffer.first().length;
        return state.length;
      }
      if (n <= state.length) return n;
      return state.ended ? state.length : 0;
    }
    Readable.prototype.read = function(n) {
      debug("read", n);
      if (n === void 0) {
        n = NaN;
      } else if (!NumberIsInteger(n)) {
        n = NumberParseInt(n, 10);
      }
      const state = this._readableState;
      const nOrig = n;
      if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
      if (n !== 0) state.state &= ~kEmittedReadable;
      if (n === 0 && state.needReadable && ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) || state.ended)) {
        debug("read: emitReadable", state.length, state.ended);
        if (state.length === 0 && state.ended) endReadable(this);
        else emitReadable(this);
        return null;
      }
      n = howMuchToRead(n, state);
      if (n === 0 && state.ended) {
        if (state.length === 0) endReadable(this);
        return null;
      }
      let doRead = (state.state & kNeedReadable) !== 0;
      debug("need readable", doRead);
      if (state.length === 0 || state.length - n < state.highWaterMark) {
        doRead = true;
        debug("length less than watermark", doRead);
      }
      if (state.ended || state.reading || state.destroyed || state.errored || !state.constructed) {
        doRead = false;
        debug("reading, ended or constructing", doRead);
      } else if (doRead) {
        debug("do read");
        state.state |= kReading | kSync;
        if (state.length === 0) state.state |= kNeedReadable;
        try {
          this._read(state.highWaterMark);
        } catch (err) {
          errorOrDestroy(this, err);
        }
        state.state &= ~kSync;
        if (!state.reading) n = howMuchToRead(nOrig, state);
      }
      let ret;
      if (n > 0) ret = fromList(n, state);
      else ret = null;
      if (ret === null) {
        state.needReadable = state.length <= state.highWaterMark;
        n = 0;
      } else {
        state.length -= n;
        if (state.multiAwaitDrain) {
          state.awaitDrainWriters.clear();
        } else {
          state.awaitDrainWriters = null;
        }
      }
      if (state.length === 0) {
        if (!state.ended) state.needReadable = true;
        if (nOrig !== n && state.ended) endReadable(this);
      }
      if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
        state.dataEmitted = true;
        this.emit("data", ret);
      }
      return ret;
    };
    function onEofChunk(stream, state) {
      debug("onEofChunk");
      if (state.ended) return;
      if (state.decoder) {
        const chunk = state.decoder.end();
        if (chunk && chunk.length) {
          state.buffer.push(chunk);
          state.length += state.objectMode ? 1 : chunk.length;
        }
      }
      state.ended = true;
      if (state.sync) {
        emitReadable(stream);
      } else {
        state.needReadable = false;
        state.emittedReadable = true;
        emitReadable_(stream);
      }
    }
    function emitReadable(stream) {
      const state = stream._readableState;
      debug("emitReadable", state.needReadable, state.emittedReadable);
      state.needReadable = false;
      if (!state.emittedReadable) {
        debug("emitReadable", state.flowing);
        state.emittedReadable = true;
        process2.nextTick(emitReadable_, stream);
      }
    }
    function emitReadable_(stream) {
      const state = stream._readableState;
      debug("emitReadable_", state.destroyed, state.length, state.ended);
      if (!state.destroyed && !state.errored && (state.length || state.ended)) {
        stream.emit("readable");
        state.emittedReadable = false;
      }
      state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
      flow(stream);
    }
    function maybeReadMore(stream, state) {
      if (!state.readingMore && state.constructed) {
        state.readingMore = true;
        process2.nextTick(maybeReadMore_, stream, state);
      }
    }
    function maybeReadMore_(stream, state) {
      while (!state.reading && !state.ended && (state.length < state.highWaterMark || state.flowing && state.length === 0)) {
        const len = state.length;
        debug("maybeReadMore read 0");
        stream.read(0);
        if (len === state.length)
          break;
      }
      state.readingMore = false;
    }
    Readable.prototype._read = function(n) {
      throw new ERR_METHOD_NOT_IMPLEMENTED("_read()");
    };
    Readable.prototype.pipe = function(dest, pipeOpts) {
      const src = this;
      const state = this._readableState;
      if (state.pipes.length === 1) {
        if (!state.multiAwaitDrain) {
          state.multiAwaitDrain = true;
          state.awaitDrainWriters = new SafeSet(state.awaitDrainWriters ? [state.awaitDrainWriters] : []);
        }
      }
      state.pipes.push(dest);
      debug("pipe count=%d opts=%j", state.pipes.length, pipeOpts);
      const doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process2.stdout && dest !== process2.stderr;
      const endFn = doEnd ? onend : unpipe;
      if (state.endEmitted) process2.nextTick(endFn);
      else src.once("end", endFn);
      dest.on("unpipe", onunpipe);
      function onunpipe(readable, unpipeInfo) {
        debug("onunpipe");
        if (readable === src) {
          if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
            unpipeInfo.hasUnpiped = true;
            cleanup();
          }
        }
      }
      function onend() {
        debug("onend");
        dest.end();
      }
      let ondrain;
      let cleanedUp = false;
      function cleanup() {
        debug("cleanup");
        dest.removeListener("close", onclose);
        dest.removeListener("finish", onfinish);
        if (ondrain) {
          dest.removeListener("drain", ondrain);
        }
        dest.removeListener("error", onerror);
        dest.removeListener("unpipe", onunpipe);
        src.removeListener("end", onend);
        src.removeListener("end", unpipe);
        src.removeListener("data", ondata);
        cleanedUp = true;
        if (ondrain && state.awaitDrainWriters && (!dest._writableState || dest._writableState.needDrain)) ondrain();
      }
      function pause() {
        if (!cleanedUp) {
          if (state.pipes.length === 1 && state.pipes[0] === dest) {
            debug("false write response, pause", 0);
            state.awaitDrainWriters = dest;
            state.multiAwaitDrain = false;
          } else if (state.pipes.length > 1 && state.pipes.includes(dest)) {
            debug("false write response, pause", state.awaitDrainWriters.size);
            state.awaitDrainWriters.add(dest);
          }
          src.pause();
        }
        if (!ondrain) {
          ondrain = pipeOnDrain(src, dest);
          dest.on("drain", ondrain);
        }
      }
      src.on("data", ondata);
      function ondata(chunk) {
        debug("ondata");
        const ret = dest.write(chunk);
        debug("dest.write", ret);
        if (ret === false) {
          pause();
        }
      }
      function onerror(er) {
        debug("onerror", er);
        unpipe();
        dest.removeListener("error", onerror);
        if (dest.listenerCount("error") === 0) {
          const s = dest._writableState || dest._readableState;
          if (s && !s.errorEmitted) {
            errorOrDestroy(dest, er);
          } else {
            dest.emit("error", er);
          }
        }
      }
      prependListener(dest, "error", onerror);
      function onclose() {
        dest.removeListener("finish", onfinish);
        unpipe();
      }
      dest.once("close", onclose);
      function onfinish() {
        debug("onfinish");
        dest.removeListener("close", onclose);
        unpipe();
      }
      dest.once("finish", onfinish);
      function unpipe() {
        debug("unpipe");
        src.unpipe(dest);
      }
      dest.emit("pipe", src);
      if (dest.writableNeedDrain === true) {
        pause();
      } else if (!state.flowing) {
        debug("pipe resume");
        src.resume();
      }
      return dest;
    };
    function pipeOnDrain(src, dest) {
      return function pipeOnDrainFunctionResult() {
        const state = src._readableState;
        if (state.awaitDrainWriters === dest) {
          debug("pipeOnDrain", 1);
          state.awaitDrainWriters = null;
        } else if (state.multiAwaitDrain) {
          debug("pipeOnDrain", state.awaitDrainWriters.size);
          state.awaitDrainWriters.delete(dest);
        }
        if ((!state.awaitDrainWriters || state.awaitDrainWriters.size === 0) && src.listenerCount("data")) {
          src.resume();
        }
      };
    }
    Readable.prototype.unpipe = function(dest) {
      const state = this._readableState;
      const unpipeInfo = {
        hasUnpiped: false
      };
      if (state.pipes.length === 0) return this;
      if (!dest) {
        const dests = state.pipes;
        state.pipes = [];
        this.pause();
        for (let i = 0; i < dests.length; i++)
          dests[i].emit("unpipe", this, {
            hasUnpiped: false
          });
        return this;
      }
      const index2 = ArrayPrototypeIndexOf(state.pipes, dest);
      if (index2 === -1) return this;
      state.pipes.splice(index2, 1);
      if (state.pipes.length === 0) this.pause();
      dest.emit("unpipe", this, unpipeInfo);
      return this;
    };
    Readable.prototype.on = function(ev, fn) {
      const res = Stream.prototype.on.call(this, ev, fn);
      const state = this._readableState;
      if (ev === "data") {
        state.readableListening = this.listenerCount("readable") > 0;
        if (state.flowing !== false) this.resume();
      } else if (ev === "readable") {
        if (!state.endEmitted && !state.readableListening) {
          state.readableListening = state.needReadable = true;
          state.flowing = false;
          state.emittedReadable = false;
          debug("on readable", state.length, state.reading);
          if (state.length) {
            emitReadable(this);
          } else if (!state.reading) {
            process2.nextTick(nReadingNextTick, this);
          }
        }
      }
      return res;
    };
    Readable.prototype.addListener = Readable.prototype.on;
    Readable.prototype.removeListener = function(ev, fn) {
      const res = Stream.prototype.removeListener.call(this, ev, fn);
      if (ev === "readable") {
        process2.nextTick(updateReadableListening, this);
      }
      return res;
    };
    Readable.prototype.off = Readable.prototype.removeListener;
    Readable.prototype.removeAllListeners = function(ev) {
      const res = Stream.prototype.removeAllListeners.apply(this, arguments);
      if (ev === "readable" || ev === void 0) {
        process2.nextTick(updateReadableListening, this);
      }
      return res;
    };
    function updateReadableListening(self) {
      const state = self._readableState;
      state.readableListening = self.listenerCount("readable") > 0;
      if (state.resumeScheduled && state[kPaused] === false) {
        state.flowing = true;
      } else if (self.listenerCount("data") > 0) {
        self.resume();
      } else if (!state.readableListening) {
        state.flowing = null;
      }
    }
    function nReadingNextTick(self) {
      debug("readable nexttick read 0");
      self.read(0);
    }
    Readable.prototype.resume = function() {
      const state = this._readableState;
      if (!state.flowing) {
        debug("resume");
        state.flowing = !state.readableListening;
        resume(this, state);
      }
      state[kPaused] = false;
      return this;
    };
    function resume(stream, state) {
      if (!state.resumeScheduled) {
        state.resumeScheduled = true;
        process2.nextTick(resume_, stream, state);
      }
    }
    function resume_(stream, state) {
      debug("resume", state.reading);
      if (!state.reading) {
        stream.read(0);
      }
      state.resumeScheduled = false;
      stream.emit("resume");
      flow(stream);
      if (state.flowing && !state.reading) stream.read(0);
    }
    Readable.prototype.pause = function() {
      debug("call pause flowing=%j", this._readableState.flowing);
      if (this._readableState.flowing !== false) {
        debug("pause");
        this._readableState.flowing = false;
        this.emit("pause");
      }
      this._readableState[kPaused] = true;
      return this;
    };
    function flow(stream) {
      const state = stream._readableState;
      debug("flow", state.flowing);
      while (state.flowing && stream.read() !== null) ;
    }
    Readable.prototype.wrap = function(stream) {
      let paused = false;
      stream.on("data", (chunk) => {
        if (!this.push(chunk) && stream.pause) {
          paused = true;
          stream.pause();
        }
      });
      stream.on("end", () => {
        this.push(null);
      });
      stream.on("error", (err) => {
        errorOrDestroy(this, err);
      });
      stream.on("close", () => {
        this.destroy();
      });
      stream.on("destroy", () => {
        this.destroy();
      });
      this._read = () => {
        if (paused && stream.resume) {
          paused = false;
          stream.resume();
        }
      };
      const streamKeys = ObjectKeys(stream);
      for (let j = 1; j < streamKeys.length; j++) {
        const i = streamKeys[j];
        if (this[i] === void 0 && typeof stream[i] === "function") {
          this[i] = stream[i].bind(stream);
        }
      }
      return this;
    };
    Readable.prototype[SymbolAsyncIterator] = function() {
      return streamToAsyncIterator(this);
    };
    Readable.prototype.iterator = function(options) {
      if (options !== void 0) {
        validateObject(options, "options");
      }
      return streamToAsyncIterator(this, options);
    };
    function streamToAsyncIterator(stream, options) {
      if (typeof stream.read !== "function") {
        stream = Readable.wrap(stream, {
          objectMode: true
        });
      }
      const iter = createAsyncIterator(stream, options);
      iter.stream = stream;
      return iter;
    }
    async function* createAsyncIterator(stream, options) {
      let callback = nop;
      function next(resolve) {
        if (this === stream) {
          callback();
          callback = nop;
        } else {
          callback = resolve;
        }
      }
      stream.on("readable", next);
      let error;
      const cleanup = eos(
        stream,
        {
          writable: false
        },
        (err) => {
          error = err ? aggregateTwoErrors(error, err) : null;
          callback();
          callback = nop;
        }
      );
      try {
        while (true) {
          const chunk = stream.destroyed ? null : stream.read();
          if (chunk !== null) {
            yield chunk;
          } else if (error) {
            throw error;
          } else if (error === null) {
            return;
          } else {
            await new Promise2(next);
          }
        }
      } catch (err) {
        error = aggregateTwoErrors(error, err);
        throw error;
      } finally {
        if ((error || (options === null || options === void 0 ? void 0 : options.destroyOnReturn) !== false) && (error === void 0 || stream._readableState.autoDestroy)) {
          destroyImpl.destroyer(stream, null);
        } else {
          stream.off("readable", next);
          cleanup();
        }
      }
    }
    ObjectDefineProperties(Readable.prototype, {
      readable: {
        __proto__: null,
        get() {
          const r = this._readableState;
          return !!r && r.readable !== false && !r.destroyed && !r.errorEmitted && !r.endEmitted;
        },
        set(val) {
          if (this._readableState) {
            this._readableState.readable = !!val;
          }
        }
      },
      readableDidRead: {
        __proto__: null,
        enumerable: false,
        get: function() {
          return this._readableState.dataEmitted;
        }
      },
      readableAborted: {
        __proto__: null,
        enumerable: false,
        get: function() {
          return !!(this._readableState.readable !== false && (this._readableState.destroyed || this._readableState.errored) && !this._readableState.endEmitted);
        }
      },
      readableHighWaterMark: {
        __proto__: null,
        enumerable: false,
        get: function() {
          return this._readableState.highWaterMark;
        }
      },
      readableBuffer: {
        __proto__: null,
        enumerable: false,
        get: function() {
          return this._readableState && this._readableState.buffer;
        }
      },
      readableFlowing: {
        __proto__: null,
        enumerable: false,
        get: function() {
          return this._readableState.flowing;
        },
        set: function(state) {
          if (this._readableState) {
            this._readableState.flowing = state;
          }
        }
      },
      readableLength: {
        __proto__: null,
        enumerable: false,
        get() {
          return this._readableState.length;
        }
      },
      readableObjectMode: {
        __proto__: null,
        enumerable: false,
        get() {
          return this._readableState ? this._readableState.objectMode : false;
        }
      },
      readableEncoding: {
        __proto__: null,
        enumerable: false,
        get() {
          return this._readableState ? this._readableState.encoding : null;
        }
      },
      errored: {
        __proto__: null,
        enumerable: false,
        get() {
          return this._readableState ? this._readableState.errored : null;
        }
      },
      closed: {
        __proto__: null,
        get() {
          return this._readableState ? this._readableState.closed : false;
        }
      },
      destroyed: {
        __proto__: null,
        enumerable: false,
        get() {
          return this._readableState ? this._readableState.destroyed : false;
        },
        set(value) {
          if (!this._readableState) {
            return;
          }
          this._readableState.destroyed = value;
        }
      },
      readableEnded: {
        __proto__: null,
        enumerable: false,
        get() {
          return this._readableState ? this._readableState.endEmitted : false;
        }
      }
    });
    ObjectDefineProperties(ReadableState.prototype, {
      // Legacy getter for `pipesCount`.
      pipesCount: {
        __proto__: null,
        get() {
          return this.pipes.length;
        }
      },
      // Legacy property for `paused`.
      paused: {
        __proto__: null,
        get() {
          return this[kPaused] !== false;
        },
        set(value) {
          this[kPaused] = !!value;
        }
      }
    });
    Readable._fromList = fromList;
    function fromList(n, state) {
      if (state.length === 0) return null;
      let ret;
      if (state.objectMode) ret = state.buffer.shift();
      else if (!n || n >= state.length) {
        if (state.decoder) ret = state.buffer.join("");
        else if (state.buffer.length === 1) ret = state.buffer.first();
        else ret = state.buffer.concat(state.length);
        state.buffer.clear();
      } else {
        ret = state.buffer.consume(n, state.decoder);
      }
      return ret;
    }
    function endReadable(stream) {
      const state = stream._readableState;
      debug("endReadable", state.endEmitted);
      if (!state.endEmitted) {
        state.ended = true;
        process2.nextTick(endReadableNT, state, stream);
      }
    }
    function endReadableNT(state, stream) {
      debug("endReadableNT", state.endEmitted, state.length);
      if (!state.errored && !state.closeEmitted && !state.endEmitted && state.length === 0) {
        state.endEmitted = true;
        stream.emit("end");
        if (stream.writable && stream.allowHalfOpen === false) {
          process2.nextTick(endWritableNT, stream);
        } else if (state.autoDestroy) {
          const wState = stream._writableState;
          const autoDestroy = !wState || wState.autoDestroy && // We don't expect the writable to ever 'finish'
          // if writable is explicitly set to false.
          (wState.finished || wState.writable === false);
          if (autoDestroy) {
            stream.destroy();
          }
        }
      }
    }
    function endWritableNT(stream) {
      const writable = stream.writable && !stream.writableEnded && !stream.destroyed;
      if (writable) {
        stream.end();
      }
    }
    Readable.from = function(iterable, opts) {
      return from(Readable, iterable, opts);
    };
    var webStreamsAdapters;
    function lazyWebStreams() {
      if (webStreamsAdapters === void 0) webStreamsAdapters = {};
      return webStreamsAdapters;
    }
    Readable.fromWeb = function(readableStream, options) {
      return lazyWebStreams().newStreamReadableFromReadableStream(readableStream, options);
    };
    Readable.toWeb = function(streamReadable, options) {
      return lazyWebStreams().newReadableStreamFromStreamReadable(streamReadable, options);
    };
    Readable.wrap = function(src, options) {
      var _ref, _src$readableObjectMo;
      return new Readable({
        objectMode: (_ref = (_src$readableObjectMo = src.readableObjectMode) !== null && _src$readableObjectMo !== void 0 ? _src$readableObjectMo : src.objectMode) !== null && _ref !== void 0 ? _ref : true,
        ...options,
        destroy(err, callback) {
          destroyImpl.destroyer(src, err);
          callback(err);
        }
      }).wrap(src);
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/writable.js
var require_writable = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/writable.js"(exports2, module2) {
    "use strict";
    var process2 = require_process();
    var {
      ArrayPrototypeSlice,
      Error: Error2,
      FunctionPrototypeSymbolHasInstance,
      ObjectDefineProperty,
      ObjectDefineProperties,
      ObjectSetPrototypeOf,
      StringPrototypeToLowerCase,
      Symbol: Symbol2,
      SymbolHasInstance
    } = require_primordials();
    module2.exports = Writable;
    Writable.WritableState = WritableState;
    var { EventEmitter: EE } = require("events");
    var Stream = require_legacy().Stream;
    var { Buffer: Buffer2 } = require("buffer");
    var destroyImpl = require_destroy();
    var { addAbortSignal } = require_add_abort_signal();
    var { getHighWaterMark, getDefaultHighWaterMark } = require_state();
    var {
      ERR_INVALID_ARG_TYPE,
      ERR_METHOD_NOT_IMPLEMENTED,
      ERR_MULTIPLE_CALLBACK,
      ERR_STREAM_CANNOT_PIPE,
      ERR_STREAM_DESTROYED,
      ERR_STREAM_ALREADY_FINISHED,
      ERR_STREAM_NULL_VALUES,
      ERR_STREAM_WRITE_AFTER_END,
      ERR_UNKNOWN_ENCODING
    } = require_errors().codes;
    var { errorOrDestroy } = destroyImpl;
    ObjectSetPrototypeOf(Writable.prototype, Stream.prototype);
    ObjectSetPrototypeOf(Writable, Stream);
    function nop() {
    }
    var kOnFinished = Symbol2("kOnFinished");
    function WritableState(options, stream, isDuplex) {
      if (typeof isDuplex !== "boolean") isDuplex = stream instanceof require_duplex();
      this.objectMode = !!(options && options.objectMode);
      if (isDuplex) this.objectMode = this.objectMode || !!(options && options.writableObjectMode);
      this.highWaterMark = options ? getHighWaterMark(this, options, "writableHighWaterMark", isDuplex) : getDefaultHighWaterMark(false);
      this.finalCalled = false;
      this.needDrain = false;
      this.ending = false;
      this.ended = false;
      this.finished = false;
      this.destroyed = false;
      const noDecode = !!(options && options.decodeStrings === false);
      this.decodeStrings = !noDecode;
      this.defaultEncoding = options && options.defaultEncoding || "utf8";
      this.length = 0;
      this.writing = false;
      this.corked = 0;
      this.sync = true;
      this.bufferProcessing = false;
      this.onwrite = onwrite.bind(void 0, stream);
      this.writecb = null;
      this.writelen = 0;
      this.afterWriteTickInfo = null;
      resetBuffer(this);
      this.pendingcb = 0;
      this.constructed = true;
      this.prefinished = false;
      this.errorEmitted = false;
      this.emitClose = !options || options.emitClose !== false;
      this.autoDestroy = !options || options.autoDestroy !== false;
      this.errored = null;
      this.closed = false;
      this.closeEmitted = false;
      this[kOnFinished] = [];
    }
    function resetBuffer(state) {
      state.buffered = [];
      state.bufferedIndex = 0;
      state.allBuffers = true;
      state.allNoop = true;
    }
    WritableState.prototype.getBuffer = function getBuffer() {
      return ArrayPrototypeSlice(this.buffered, this.bufferedIndex);
    };
    ObjectDefineProperty(WritableState.prototype, "bufferedRequestCount", {
      __proto__: null,
      get() {
        return this.buffered.length - this.bufferedIndex;
      }
    });
    function Writable(options) {
      const isDuplex = this instanceof require_duplex();
      if (!isDuplex && !FunctionPrototypeSymbolHasInstance(Writable, this)) return new Writable(options);
      this._writableState = new WritableState(options, this, isDuplex);
      if (options) {
        if (typeof options.write === "function") this._write = options.write;
        if (typeof options.writev === "function") this._writev = options.writev;
        if (typeof options.destroy === "function") this._destroy = options.destroy;
        if (typeof options.final === "function") this._final = options.final;
        if (typeof options.construct === "function") this._construct = options.construct;
        if (options.signal) addAbortSignal(options.signal, this);
      }
      Stream.call(this, options);
      destroyImpl.construct(this, () => {
        const state = this._writableState;
        if (!state.writing) {
          clearBuffer(this, state);
        }
        finishMaybe(this, state);
      });
    }
    ObjectDefineProperty(Writable, SymbolHasInstance, {
      __proto__: null,
      value: function(object) {
        if (FunctionPrototypeSymbolHasInstance(this, object)) return true;
        if (this !== Writable) return false;
        return object && object._writableState instanceof WritableState;
      }
    });
    Writable.prototype.pipe = function() {
      errorOrDestroy(this, new ERR_STREAM_CANNOT_PIPE());
    };
    function _write(stream, chunk, encoding, cb) {
      const state = stream._writableState;
      if (typeof encoding === "function") {
        cb = encoding;
        encoding = state.defaultEncoding;
      } else {
        if (!encoding) encoding = state.defaultEncoding;
        else if (encoding !== "buffer" && !Buffer2.isEncoding(encoding)) throw new ERR_UNKNOWN_ENCODING(encoding);
        if (typeof cb !== "function") cb = nop;
      }
      if (chunk === null) {
        throw new ERR_STREAM_NULL_VALUES();
      } else if (!state.objectMode) {
        if (typeof chunk === "string") {
          if (state.decodeStrings !== false) {
            chunk = Buffer2.from(chunk, encoding);
            encoding = "buffer";
          }
        } else if (chunk instanceof Buffer2) {
          encoding = "buffer";
        } else if (Stream._isUint8Array(chunk)) {
          chunk = Stream._uint8ArrayToBuffer(chunk);
          encoding = "buffer";
        } else {
          throw new ERR_INVALID_ARG_TYPE("chunk", ["string", "Buffer", "Uint8Array"], chunk);
        }
      }
      let err;
      if (state.ending) {
        err = new ERR_STREAM_WRITE_AFTER_END();
      } else if (state.destroyed) {
        err = new ERR_STREAM_DESTROYED("write");
      }
      if (err) {
        process2.nextTick(cb, err);
        errorOrDestroy(stream, err, true);
        return err;
      }
      state.pendingcb++;
      return writeOrBuffer(stream, state, chunk, encoding, cb);
    }
    Writable.prototype.write = function(chunk, encoding, cb) {
      return _write(this, chunk, encoding, cb) === true;
    };
    Writable.prototype.cork = function() {
      this._writableState.corked++;
    };
    Writable.prototype.uncork = function() {
      const state = this._writableState;
      if (state.corked) {
        state.corked--;
        if (!state.writing) clearBuffer(this, state);
      }
    };
    Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
      if (typeof encoding === "string") encoding = StringPrototypeToLowerCase(encoding);
      if (!Buffer2.isEncoding(encoding)) throw new ERR_UNKNOWN_ENCODING(encoding);
      this._writableState.defaultEncoding = encoding;
      return this;
    };
    function writeOrBuffer(stream, state, chunk, encoding, callback) {
      const len = state.objectMode ? 1 : chunk.length;
      state.length += len;
      const ret = state.length < state.highWaterMark;
      if (!ret) state.needDrain = true;
      if (state.writing || state.corked || state.errored || !state.constructed) {
        state.buffered.push({
          chunk,
          encoding,
          callback
        });
        if (state.allBuffers && encoding !== "buffer") {
          state.allBuffers = false;
        }
        if (state.allNoop && callback !== nop) {
          state.allNoop = false;
        }
      } else {
        state.writelen = len;
        state.writecb = callback;
        state.writing = true;
        state.sync = true;
        stream._write(chunk, encoding, state.onwrite);
        state.sync = false;
      }
      return ret && !state.errored && !state.destroyed;
    }
    function doWrite(stream, state, writev, len, chunk, encoding, cb) {
      state.writelen = len;
      state.writecb = cb;
      state.writing = true;
      state.sync = true;
      if (state.destroyed) state.onwrite(new ERR_STREAM_DESTROYED("write"));
      else if (writev) stream._writev(chunk, state.onwrite);
      else stream._write(chunk, encoding, state.onwrite);
      state.sync = false;
    }
    function onwriteError(stream, state, er, cb) {
      --state.pendingcb;
      cb(er);
      errorBuffer(state);
      errorOrDestroy(stream, er);
    }
    function onwrite(stream, er) {
      const state = stream._writableState;
      const sync = state.sync;
      const cb = state.writecb;
      if (typeof cb !== "function") {
        errorOrDestroy(stream, new ERR_MULTIPLE_CALLBACK());
        return;
      }
      state.writing = false;
      state.writecb = null;
      state.length -= state.writelen;
      state.writelen = 0;
      if (er) {
        er.stack;
        if (!state.errored) {
          state.errored = er;
        }
        if (stream._readableState && !stream._readableState.errored) {
          stream._readableState.errored = er;
        }
        if (sync) {
          process2.nextTick(onwriteError, stream, state, er, cb);
        } else {
          onwriteError(stream, state, er, cb);
        }
      } else {
        if (state.buffered.length > state.bufferedIndex) {
          clearBuffer(stream, state);
        }
        if (sync) {
          if (state.afterWriteTickInfo !== null && state.afterWriteTickInfo.cb === cb) {
            state.afterWriteTickInfo.count++;
          } else {
            state.afterWriteTickInfo = {
              count: 1,
              cb,
              stream,
              state
            };
            process2.nextTick(afterWriteTick, state.afterWriteTickInfo);
          }
        } else {
          afterWrite(stream, state, 1, cb);
        }
      }
    }
    function afterWriteTick({ stream, state, count, cb }) {
      state.afterWriteTickInfo = null;
      return afterWrite(stream, state, count, cb);
    }
    function afterWrite(stream, state, count, cb) {
      const needDrain = !state.ending && !stream.destroyed && state.length === 0 && state.needDrain;
      if (needDrain) {
        state.needDrain = false;
        stream.emit("drain");
      }
      while (count-- > 0) {
        state.pendingcb--;
        cb();
      }
      if (state.destroyed) {
        errorBuffer(state);
      }
      finishMaybe(stream, state);
    }
    function errorBuffer(state) {
      if (state.writing) {
        return;
      }
      for (let n = state.bufferedIndex; n < state.buffered.length; ++n) {
        var _state$errored;
        const { chunk, callback } = state.buffered[n];
        const len = state.objectMode ? 1 : chunk.length;
        state.length -= len;
        callback(
          (_state$errored = state.errored) !== null && _state$errored !== void 0 ? _state$errored : new ERR_STREAM_DESTROYED("write")
        );
      }
      const onfinishCallbacks = state[kOnFinished].splice(0);
      for (let i = 0; i < onfinishCallbacks.length; i++) {
        var _state$errored2;
        onfinishCallbacks[i](
          (_state$errored2 = state.errored) !== null && _state$errored2 !== void 0 ? _state$errored2 : new ERR_STREAM_DESTROYED("end")
        );
      }
      resetBuffer(state);
    }
    function clearBuffer(stream, state) {
      if (state.corked || state.bufferProcessing || state.destroyed || !state.constructed) {
        return;
      }
      const { buffered, bufferedIndex, objectMode } = state;
      const bufferedLength = buffered.length - bufferedIndex;
      if (!bufferedLength) {
        return;
      }
      let i = bufferedIndex;
      state.bufferProcessing = true;
      if (bufferedLength > 1 && stream._writev) {
        state.pendingcb -= bufferedLength - 1;
        const callback = state.allNoop ? nop : (err) => {
          for (let n = i; n < buffered.length; ++n) {
            buffered[n].callback(err);
          }
        };
        const chunks = state.allNoop && i === 0 ? buffered : ArrayPrototypeSlice(buffered, i);
        chunks.allBuffers = state.allBuffers;
        doWrite(stream, state, true, state.length, chunks, "", callback);
        resetBuffer(state);
      } else {
        do {
          const { chunk, encoding, callback } = buffered[i];
          buffered[i++] = null;
          const len = objectMode ? 1 : chunk.length;
          doWrite(stream, state, false, len, chunk, encoding, callback);
        } while (i < buffered.length && !state.writing);
        if (i === buffered.length) {
          resetBuffer(state);
        } else if (i > 256) {
          buffered.splice(0, i);
          state.bufferedIndex = 0;
        } else {
          state.bufferedIndex = i;
        }
      }
      state.bufferProcessing = false;
    }
    Writable.prototype._write = function(chunk, encoding, cb) {
      if (this._writev) {
        this._writev(
          [
            {
              chunk,
              encoding
            }
          ],
          cb
        );
      } else {
        throw new ERR_METHOD_NOT_IMPLEMENTED("_write()");
      }
    };
    Writable.prototype._writev = null;
    Writable.prototype.end = function(chunk, encoding, cb) {
      const state = this._writableState;
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = null;
        encoding = null;
      } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = null;
      }
      let err;
      if (chunk !== null && chunk !== void 0) {
        const ret = _write(this, chunk, encoding);
        if (ret instanceof Error2) {
          err = ret;
        }
      }
      if (state.corked) {
        state.corked = 1;
        this.uncork();
      }
      if (err) {
      } else if (!state.errored && !state.ending) {
        state.ending = true;
        finishMaybe(this, state, true);
        state.ended = true;
      } else if (state.finished) {
        err = new ERR_STREAM_ALREADY_FINISHED("end");
      } else if (state.destroyed) {
        err = new ERR_STREAM_DESTROYED("end");
      }
      if (typeof cb === "function") {
        if (err || state.finished) {
          process2.nextTick(cb, err);
        } else {
          state[kOnFinished].push(cb);
        }
      }
      return this;
    };
    function needFinish(state) {
      return state.ending && !state.destroyed && state.constructed && state.length === 0 && !state.errored && state.buffered.length === 0 && !state.finished && !state.writing && !state.errorEmitted && !state.closeEmitted;
    }
    function callFinal(stream, state) {
      let called = false;
      function onFinish(err) {
        if (called) {
          errorOrDestroy(stream, err !== null && err !== void 0 ? err : ERR_MULTIPLE_CALLBACK());
          return;
        }
        called = true;
        state.pendingcb--;
        if (err) {
          const onfinishCallbacks = state[kOnFinished].splice(0);
          for (let i = 0; i < onfinishCallbacks.length; i++) {
            onfinishCallbacks[i](err);
          }
          errorOrDestroy(stream, err, state.sync);
        } else if (needFinish(state)) {
          state.prefinished = true;
          stream.emit("prefinish");
          state.pendingcb++;
          process2.nextTick(finish, stream, state);
        }
      }
      state.sync = true;
      state.pendingcb++;
      try {
        stream._final(onFinish);
      } catch (err) {
        onFinish(err);
      }
      state.sync = false;
    }
    function prefinish(stream, state) {
      if (!state.prefinished && !state.finalCalled) {
        if (typeof stream._final === "function" && !state.destroyed) {
          state.finalCalled = true;
          callFinal(stream, state);
        } else {
          state.prefinished = true;
          stream.emit("prefinish");
        }
      }
    }
    function finishMaybe(stream, state, sync) {
      if (needFinish(state)) {
        prefinish(stream, state);
        if (state.pendingcb === 0) {
          if (sync) {
            state.pendingcb++;
            process2.nextTick(
              (stream2, state2) => {
                if (needFinish(state2)) {
                  finish(stream2, state2);
                } else {
                  state2.pendingcb--;
                }
              },
              stream,
              state
            );
          } else if (needFinish(state)) {
            state.pendingcb++;
            finish(stream, state);
          }
        }
      }
    }
    function finish(stream, state) {
      state.pendingcb--;
      state.finished = true;
      const onfinishCallbacks = state[kOnFinished].splice(0);
      for (let i = 0; i < onfinishCallbacks.length; i++) {
        onfinishCallbacks[i]();
      }
      stream.emit("finish");
      if (state.autoDestroy) {
        const rState = stream._readableState;
        const autoDestroy = !rState || rState.autoDestroy && // We don't expect the readable to ever 'end'
        // if readable is explicitly set to false.
        (rState.endEmitted || rState.readable === false);
        if (autoDestroy) {
          stream.destroy();
        }
      }
    }
    ObjectDefineProperties(Writable.prototype, {
      closed: {
        __proto__: null,
        get() {
          return this._writableState ? this._writableState.closed : false;
        }
      },
      destroyed: {
        __proto__: null,
        get() {
          return this._writableState ? this._writableState.destroyed : false;
        },
        set(value) {
          if (this._writableState) {
            this._writableState.destroyed = value;
          }
        }
      },
      writable: {
        __proto__: null,
        get() {
          const w = this._writableState;
          return !!w && w.writable !== false && !w.destroyed && !w.errored && !w.ending && !w.ended;
        },
        set(val) {
          if (this._writableState) {
            this._writableState.writable = !!val;
          }
        }
      },
      writableFinished: {
        __proto__: null,
        get() {
          return this._writableState ? this._writableState.finished : false;
        }
      },
      writableObjectMode: {
        __proto__: null,
        get() {
          return this._writableState ? this._writableState.objectMode : false;
        }
      },
      writableBuffer: {
        __proto__: null,
        get() {
          return this._writableState && this._writableState.getBuffer();
        }
      },
      writableEnded: {
        __proto__: null,
        get() {
          return this._writableState ? this._writableState.ending : false;
        }
      },
      writableNeedDrain: {
        __proto__: null,
        get() {
          const wState = this._writableState;
          if (!wState) return false;
          return !wState.destroyed && !wState.ending && wState.needDrain;
        }
      },
      writableHighWaterMark: {
        __proto__: null,
        get() {
          return this._writableState && this._writableState.highWaterMark;
        }
      },
      writableCorked: {
        __proto__: null,
        get() {
          return this._writableState ? this._writableState.corked : 0;
        }
      },
      writableLength: {
        __proto__: null,
        get() {
          return this._writableState && this._writableState.length;
        }
      },
      errored: {
        __proto__: null,
        enumerable: false,
        get() {
          return this._writableState ? this._writableState.errored : null;
        }
      },
      writableAborted: {
        __proto__: null,
        enumerable: false,
        get: function() {
          return !!(this._writableState.writable !== false && (this._writableState.destroyed || this._writableState.errored) && !this._writableState.finished);
        }
      }
    });
    var destroy = destroyImpl.destroy;
    Writable.prototype.destroy = function(err, cb) {
      const state = this._writableState;
      if (!state.destroyed && (state.bufferedIndex < state.buffered.length || state[kOnFinished].length)) {
        process2.nextTick(errorBuffer, state);
      }
      destroy.call(this, err, cb);
      return this;
    };
    Writable.prototype._undestroy = destroyImpl.undestroy;
    Writable.prototype._destroy = function(err, cb) {
      cb(err);
    };
    Writable.prototype[EE.captureRejectionSymbol] = function(err) {
      this.destroy(err);
    };
    var webStreamsAdapters;
    function lazyWebStreams() {
      if (webStreamsAdapters === void 0) webStreamsAdapters = {};
      return webStreamsAdapters;
    }
    Writable.fromWeb = function(writableStream, options) {
      return lazyWebStreams().newStreamWritableFromWritableStream(writableStream, options);
    };
    Writable.toWeb = function(streamWritable) {
      return lazyWebStreams().newWritableStreamFromStreamWritable(streamWritable);
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/duplexify.js
var require_duplexify = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/duplexify.js"(exports2, module2) {
    var process2 = require_process();
    var bufferModule = require("buffer");
    var {
      isReadable,
      isWritable,
      isIterable,
      isNodeStream,
      isReadableNodeStream,
      isWritableNodeStream,
      isDuplexNodeStream,
      isReadableStream,
      isWritableStream
    } = require_utils();
    var eos = require_end_of_stream();
    var {
      AbortError,
      codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_RETURN_VALUE }
    } = require_errors();
    var { destroyer } = require_destroy();
    var Duplex = require_duplex();
    var Readable = require_readable();
    var Writable = require_writable();
    var { createDeferredPromise } = require_util();
    var from = require_from();
    var Blob = globalThis.Blob || bufferModule.Blob;
    var isBlob = typeof Blob !== "undefined" ? function isBlob2(b) {
      return b instanceof Blob;
    } : function isBlob2(b) {
      return false;
    };
    var AbortController = globalThis.AbortController || require_abort_controller().AbortController;
    var { FunctionPrototypeCall } = require_primordials();
    var Duplexify = class extends Duplex {
      constructor(options) {
        super(options);
        if ((options === null || options === void 0 ? void 0 : options.readable) === false) {
          this._readableState.readable = false;
          this._readableState.ended = true;
          this._readableState.endEmitted = true;
        }
        if ((options === null || options === void 0 ? void 0 : options.writable) === false) {
          this._writableState.writable = false;
          this._writableState.ending = true;
          this._writableState.ended = true;
          this._writableState.finished = true;
        }
      }
    };
    module2.exports = function duplexify(body, name) {
      if (isDuplexNodeStream(body)) {
        return body;
      }
      if (isReadableNodeStream(body)) {
        return _duplexify({
          readable: body
        });
      }
      if (isWritableNodeStream(body)) {
        return _duplexify({
          writable: body
        });
      }
      if (isNodeStream(body)) {
        return _duplexify({
          writable: false,
          readable: false
        });
      }
      if (isReadableStream(body)) {
        return _duplexify({
          readable: Readable.fromWeb(body)
        });
      }
      if (isWritableStream(body)) {
        return _duplexify({
          writable: Writable.fromWeb(body)
        });
      }
      if (typeof body === "function") {
        const { value, write, final, destroy } = fromAsyncGen(body);
        if (isIterable(value)) {
          return from(Duplexify, value, {
            // TODO (ronag): highWaterMark?
            objectMode: true,
            write,
            final,
            destroy
          });
        }
        const then2 = value === null || value === void 0 ? void 0 : value.then;
        if (typeof then2 === "function") {
          let d;
          const promise = FunctionPrototypeCall(
            then2,
            value,
            (val) => {
              if (val != null) {
                throw new ERR_INVALID_RETURN_VALUE("nully", "body", val);
              }
            },
            (err) => {
              destroyer(d, err);
            }
          );
          return d = new Duplexify({
            // TODO (ronag): highWaterMark?
            objectMode: true,
            readable: false,
            write,
            final(cb) {
              final(async () => {
                try {
                  await promise;
                  process2.nextTick(cb, null);
                } catch (err) {
                  process2.nextTick(cb, err);
                }
              });
            },
            destroy
          });
        }
        throw new ERR_INVALID_RETURN_VALUE("Iterable, AsyncIterable or AsyncFunction", name, value);
      }
      if (isBlob(body)) {
        return duplexify(body.arrayBuffer());
      }
      if (isIterable(body)) {
        return from(Duplexify, body, {
          // TODO (ronag): highWaterMark?
          objectMode: true,
          writable: false
        });
      }
      if (isReadableStream(body === null || body === void 0 ? void 0 : body.readable) && isWritableStream(body === null || body === void 0 ? void 0 : body.writable)) {
        return Duplexify.fromWeb(body);
      }
      if (typeof (body === null || body === void 0 ? void 0 : body.writable) === "object" || typeof (body === null || body === void 0 ? void 0 : body.readable) === "object") {
        const readable = body !== null && body !== void 0 && body.readable ? isReadableNodeStream(body === null || body === void 0 ? void 0 : body.readable) ? body === null || body === void 0 ? void 0 : body.readable : duplexify(body.readable) : void 0;
        const writable = body !== null && body !== void 0 && body.writable ? isWritableNodeStream(body === null || body === void 0 ? void 0 : body.writable) ? body === null || body === void 0 ? void 0 : body.writable : duplexify(body.writable) : void 0;
        return _duplexify({
          readable,
          writable
        });
      }
      const then = body === null || body === void 0 ? void 0 : body.then;
      if (typeof then === "function") {
        let d;
        FunctionPrototypeCall(
          then,
          body,
          (val) => {
            if (val != null) {
              d.push(val);
            }
            d.push(null);
          },
          (err) => {
            destroyer(d, err);
          }
        );
        return d = new Duplexify({
          objectMode: true,
          writable: false,
          read() {
          }
        });
      }
      throw new ERR_INVALID_ARG_TYPE(
        name,
        [
          "Blob",
          "ReadableStream",
          "WritableStream",
          "Stream",
          "Iterable",
          "AsyncIterable",
          "Function",
          "{ readable, writable } pair",
          "Promise"
        ],
        body
      );
    };
    function fromAsyncGen(fn) {
      let { promise, resolve } = createDeferredPromise();
      const ac = new AbortController();
      const signal = ac.signal;
      const value = fn(
        (async function* () {
          while (true) {
            const _promise = promise;
            promise = null;
            const { chunk, done, cb } = await _promise;
            process2.nextTick(cb);
            if (done) return;
            if (signal.aborted)
              throw new AbortError(void 0, {
                cause: signal.reason
              });
            ({ promise, resolve } = createDeferredPromise());
            yield chunk;
          }
        })(),
        {
          signal
        }
      );
      return {
        value,
        write(chunk, encoding, cb) {
          const _resolve = resolve;
          resolve = null;
          _resolve({
            chunk,
            done: false,
            cb
          });
        },
        final(cb) {
          const _resolve = resolve;
          resolve = null;
          _resolve({
            done: true,
            cb
          });
        },
        destroy(err, cb) {
          ac.abort();
          cb(err);
        }
      };
    }
    function _duplexify(pair) {
      const r = pair.readable && typeof pair.readable.read !== "function" ? Readable.wrap(pair.readable) : pair.readable;
      const w = pair.writable;
      let readable = !!isReadable(r);
      let writable = !!isWritable(w);
      let ondrain;
      let onfinish;
      let onreadable;
      let onclose;
      let d;
      function onfinished(err) {
        const cb = onclose;
        onclose = null;
        if (cb) {
          cb(err);
        } else if (err) {
          d.destroy(err);
        }
      }
      d = new Duplexify({
        // TODO (ronag): highWaterMark?
        readableObjectMode: !!(r !== null && r !== void 0 && r.readableObjectMode),
        writableObjectMode: !!(w !== null && w !== void 0 && w.writableObjectMode),
        readable,
        writable
      });
      if (writable) {
        eos(w, (err) => {
          writable = false;
          if (err) {
            destroyer(r, err);
          }
          onfinished(err);
        });
        d._write = function(chunk, encoding, callback) {
          if (w.write(chunk, encoding)) {
            callback();
          } else {
            ondrain = callback;
          }
        };
        d._final = function(callback) {
          w.end();
          onfinish = callback;
        };
        w.on("drain", function() {
          if (ondrain) {
            const cb = ondrain;
            ondrain = null;
            cb();
          }
        });
        w.on("finish", function() {
          if (onfinish) {
            const cb = onfinish;
            onfinish = null;
            cb();
          }
        });
      }
      if (readable) {
        eos(r, (err) => {
          readable = false;
          if (err) {
            destroyer(r, err);
          }
          onfinished(err);
        });
        r.on("readable", function() {
          if (onreadable) {
            const cb = onreadable;
            onreadable = null;
            cb();
          }
        });
        r.on("end", function() {
          d.push(null);
        });
        d._read = function() {
          while (true) {
            const buf = r.read();
            if (buf === null) {
              onreadable = d._read;
              return;
            }
            if (!d.push(buf)) {
              return;
            }
          }
        };
      }
      d._destroy = function(err, callback) {
        if (!err && onclose !== null) {
          err = new AbortError();
        }
        onreadable = null;
        ondrain = null;
        onfinish = null;
        if (onclose === null) {
          callback(err);
        } else {
          onclose = callback;
          destroyer(w, err);
          destroyer(r, err);
        }
      };
      return d;
    }
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/duplex.js
var require_duplex = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/duplex.js"(exports2, module2) {
    "use strict";
    var {
      ObjectDefineProperties,
      ObjectGetOwnPropertyDescriptor,
      ObjectKeys,
      ObjectSetPrototypeOf
    } = require_primordials();
    module2.exports = Duplex;
    var Readable = require_readable();
    var Writable = require_writable();
    ObjectSetPrototypeOf(Duplex.prototype, Readable.prototype);
    ObjectSetPrototypeOf(Duplex, Readable);
    {
      const keys = ObjectKeys(Writable.prototype);
      for (let i = 0; i < keys.length; i++) {
        const method = keys[i];
        if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
      }
    }
    function Duplex(options) {
      if (!(this instanceof Duplex)) return new Duplex(options);
      Readable.call(this, options);
      Writable.call(this, options);
      if (options) {
        this.allowHalfOpen = options.allowHalfOpen !== false;
        if (options.readable === false) {
          this._readableState.readable = false;
          this._readableState.ended = true;
          this._readableState.endEmitted = true;
        }
        if (options.writable === false) {
          this._writableState.writable = false;
          this._writableState.ending = true;
          this._writableState.ended = true;
          this._writableState.finished = true;
        }
      } else {
        this.allowHalfOpen = true;
      }
    }
    ObjectDefineProperties(Duplex.prototype, {
      writable: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writable")
      },
      writableHighWaterMark: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableHighWaterMark")
      },
      writableObjectMode: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableObjectMode")
      },
      writableBuffer: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableBuffer")
      },
      writableLength: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableLength")
      },
      writableFinished: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableFinished")
      },
      writableCorked: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableCorked")
      },
      writableEnded: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableEnded")
      },
      writableNeedDrain: {
        __proto__: null,
        ...ObjectGetOwnPropertyDescriptor(Writable.prototype, "writableNeedDrain")
      },
      destroyed: {
        __proto__: null,
        get() {
          if (this._readableState === void 0 || this._writableState === void 0) {
            return false;
          }
          return this._readableState.destroyed && this._writableState.destroyed;
        },
        set(value) {
          if (this._readableState && this._writableState) {
            this._readableState.destroyed = value;
            this._writableState.destroyed = value;
          }
        }
      }
    });
    var webStreamsAdapters;
    function lazyWebStreams() {
      if (webStreamsAdapters === void 0) webStreamsAdapters = {};
      return webStreamsAdapters;
    }
    Duplex.fromWeb = function(pair, options) {
      return lazyWebStreams().newStreamDuplexFromReadableWritablePair(pair, options);
    };
    Duplex.toWeb = function(duplex) {
      return lazyWebStreams().newReadableWritablePairFromDuplex(duplex);
    };
    var duplexify;
    Duplex.from = function(body) {
      if (!duplexify) {
        duplexify = require_duplexify();
      }
      return duplexify(body, "body");
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/transform.js
var require_transform = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/transform.js"(exports2, module2) {
    "use strict";
    var { ObjectSetPrototypeOf, Symbol: Symbol2 } = require_primordials();
    module2.exports = Transform;
    var { ERR_METHOD_NOT_IMPLEMENTED } = require_errors().codes;
    var Duplex = require_duplex();
    var { getHighWaterMark } = require_state();
    ObjectSetPrototypeOf(Transform.prototype, Duplex.prototype);
    ObjectSetPrototypeOf(Transform, Duplex);
    var kCallback = Symbol2("kCallback");
    function Transform(options) {
      if (!(this instanceof Transform)) return new Transform(options);
      const readableHighWaterMark = options ? getHighWaterMark(this, options, "readableHighWaterMark", true) : null;
      if (readableHighWaterMark === 0) {
        options = {
          ...options,
          highWaterMark: null,
          readableHighWaterMark,
          // TODO (ronag): 0 is not optimal since we have
          // a "bug" where we check needDrain before calling _write and not after.
          // Refs: https://github.com/nodejs/node/pull/32887
          // Refs: https://github.com/nodejs/node/pull/35941
          writableHighWaterMark: options.writableHighWaterMark || 0
        };
      }
      Duplex.call(this, options);
      this._readableState.sync = false;
      this[kCallback] = null;
      if (options) {
        if (typeof options.transform === "function") this._transform = options.transform;
        if (typeof options.flush === "function") this._flush = options.flush;
      }
      this.on("prefinish", prefinish);
    }
    function final(cb) {
      if (typeof this._flush === "function" && !this.destroyed) {
        this._flush((er, data) => {
          if (er) {
            if (cb) {
              cb(er);
            } else {
              this.destroy(er);
            }
            return;
          }
          if (data != null) {
            this.push(data);
          }
          this.push(null);
          if (cb) {
            cb();
          }
        });
      } else {
        this.push(null);
        if (cb) {
          cb();
        }
      }
    }
    function prefinish() {
      if (this._final !== final) {
        final.call(this);
      }
    }
    Transform.prototype._final = final;
    Transform.prototype._transform = function(chunk, encoding, callback) {
      throw new ERR_METHOD_NOT_IMPLEMENTED("_transform()");
    };
    Transform.prototype._write = function(chunk, encoding, callback) {
      const rState = this._readableState;
      const wState = this._writableState;
      const length = rState.length;
      this._transform(chunk, encoding, (err, val) => {
        if (err) {
          callback(err);
          return;
        }
        if (val != null) {
          this.push(val);
        }
        if (wState.ended || // Backwards compat.
        length === rState.length || // Backwards compat.
        rState.length < rState.highWaterMark) {
          callback();
        } else {
          this[kCallback] = callback;
        }
      });
    };
    Transform.prototype._read = function() {
      if (this[kCallback]) {
        const callback = this[kCallback];
        this[kCallback] = null;
        callback();
      }
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/passthrough.js
var require_passthrough = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/passthrough.js"(exports2, module2) {
    "use strict";
    var { ObjectSetPrototypeOf } = require_primordials();
    module2.exports = PassThrough;
    var Transform = require_transform();
    ObjectSetPrototypeOf(PassThrough.prototype, Transform.prototype);
    ObjectSetPrototypeOf(PassThrough, Transform);
    function PassThrough(options) {
      if (!(this instanceof PassThrough)) return new PassThrough(options);
      Transform.call(this, options);
    }
    PassThrough.prototype._transform = function(chunk, encoding, cb) {
      cb(null, chunk);
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/pipeline.js
var require_pipeline = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/pipeline.js"(exports2, module2) {
    var process2 = require_process();
    var { ArrayIsArray, Promise: Promise2, SymbolAsyncIterator, SymbolDispose } = require_primordials();
    var eos = require_end_of_stream();
    var { once } = require_util();
    var destroyImpl = require_destroy();
    var Duplex = require_duplex();
    var {
      aggregateTwoErrors,
      codes: {
        ERR_INVALID_ARG_TYPE,
        ERR_INVALID_RETURN_VALUE,
        ERR_MISSING_ARGS,
        ERR_STREAM_DESTROYED,
        ERR_STREAM_PREMATURE_CLOSE
      },
      AbortError
    } = require_errors();
    var { validateFunction, validateAbortSignal } = require_validators();
    var {
      isIterable,
      isReadable,
      isReadableNodeStream,
      isNodeStream,
      isTransformStream,
      isWebStream,
      isReadableStream,
      isReadableFinished
    } = require_utils();
    var AbortController = globalThis.AbortController || require_abort_controller().AbortController;
    var PassThrough;
    var Readable;
    var addAbortListener;
    function destroyer(stream, reading, writing) {
      let finished = false;
      stream.on("close", () => {
        finished = true;
      });
      const cleanup = eos(
        stream,
        {
          readable: reading,
          writable: writing
        },
        (err) => {
          finished = !err;
        }
      );
      return {
        destroy: (err) => {
          if (finished) return;
          finished = true;
          destroyImpl.destroyer(stream, err || new ERR_STREAM_DESTROYED("pipe"));
        },
        cleanup
      };
    }
    function popCallback(streams) {
      validateFunction(streams[streams.length - 1], "streams[stream.length - 1]");
      return streams.pop();
    }
    function makeAsyncIterable(val) {
      if (isIterable(val)) {
        return val;
      } else if (isReadableNodeStream(val)) {
        return fromReadable(val);
      }
      throw new ERR_INVALID_ARG_TYPE("val", ["Readable", "Iterable", "AsyncIterable"], val);
    }
    async function* fromReadable(val) {
      if (!Readable) {
        Readable = require_readable();
      }
      yield* Readable.prototype[SymbolAsyncIterator].call(val);
    }
    async function pumpToNode(iterable, writable, finish, { end }) {
      let error;
      let onresolve = null;
      const resume = (err) => {
        if (err) {
          error = err;
        }
        if (onresolve) {
          const callback = onresolve;
          onresolve = null;
          callback();
        }
      };
      const wait = () => new Promise2((resolve, reject) => {
        if (error) {
          reject(error);
        } else {
          onresolve = () => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          };
        }
      });
      writable.on("drain", resume);
      const cleanup = eos(
        writable,
        {
          readable: false
        },
        resume
      );
      try {
        if (writable.writableNeedDrain) {
          await wait();
        }
        for await (const chunk of iterable) {
          if (!writable.write(chunk)) {
            await wait();
          }
        }
        if (end) {
          writable.end();
          await wait();
        }
        finish();
      } catch (err) {
        finish(error !== err ? aggregateTwoErrors(error, err) : err);
      } finally {
        cleanup();
        writable.off("drain", resume);
      }
    }
    async function pumpToWeb(readable, writable, finish, { end }) {
      if (isTransformStream(writable)) {
        writable = writable.writable;
      }
      const writer = writable.getWriter();
      try {
        for await (const chunk of readable) {
          await writer.ready;
          writer.write(chunk).catch(() => {
          });
        }
        await writer.ready;
        if (end) {
          await writer.close();
        }
        finish();
      } catch (err) {
        try {
          await writer.abort(err);
          finish(err);
        } catch (err2) {
          finish(err2);
        }
      }
    }
    function pipeline(...streams) {
      return pipelineImpl(streams, once(popCallback(streams)));
    }
    function pipelineImpl(streams, callback, opts) {
      if (streams.length === 1 && ArrayIsArray(streams[0])) {
        streams = streams[0];
      }
      if (streams.length < 2) {
        throw new ERR_MISSING_ARGS("streams");
      }
      const ac = new AbortController();
      const signal = ac.signal;
      const outerSignal = opts === null || opts === void 0 ? void 0 : opts.signal;
      const lastStreamCleanup = [];
      validateAbortSignal(outerSignal, "options.signal");
      function abort() {
        finishImpl(new AbortError());
      }
      addAbortListener = addAbortListener || require_util().addAbortListener;
      let disposable;
      if (outerSignal) {
        disposable = addAbortListener(outerSignal, abort);
      }
      let error;
      let value;
      const destroys = [];
      let finishCount = 0;
      function finish(err) {
        finishImpl(err, --finishCount === 0);
      }
      function finishImpl(err, final) {
        var _disposable;
        if (err && (!error || error.code === "ERR_STREAM_PREMATURE_CLOSE")) {
          error = err;
        }
        if (!error && !final) {
          return;
        }
        while (destroys.length) {
          destroys.shift()(error);
        }
        ;
        (_disposable = disposable) === null || _disposable === void 0 ? void 0 : _disposable[SymbolDispose]();
        ac.abort();
        if (final) {
          if (!error) {
            lastStreamCleanup.forEach((fn) => fn());
          }
          process2.nextTick(callback, error, value);
        }
      }
      let ret;
      for (let i = 0; i < streams.length; i++) {
        const stream = streams[i];
        const reading = i < streams.length - 1;
        const writing = i > 0;
        const end = reading || (opts === null || opts === void 0 ? void 0 : opts.end) !== false;
        const isLastStream = i === streams.length - 1;
        if (isNodeStream(stream)) {
          let onError2 = function(err) {
            if (err && err.name !== "AbortError" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
              finish(err);
            }
          };
          var onError = onError2;
          if (end) {
            const { destroy, cleanup } = destroyer(stream, reading, writing);
            destroys.push(destroy);
            if (isReadable(stream) && isLastStream) {
              lastStreamCleanup.push(cleanup);
            }
          }
          stream.on("error", onError2);
          if (isReadable(stream) && isLastStream) {
            lastStreamCleanup.push(() => {
              stream.removeListener("error", onError2);
            });
          }
        }
        if (i === 0) {
          if (typeof stream === "function") {
            ret = stream({
              signal
            });
            if (!isIterable(ret)) {
              throw new ERR_INVALID_RETURN_VALUE("Iterable, AsyncIterable or Stream", "source", ret);
            }
          } else if (isIterable(stream) || isReadableNodeStream(stream) || isTransformStream(stream)) {
            ret = stream;
          } else {
            ret = Duplex.from(stream);
          }
        } else if (typeof stream === "function") {
          if (isTransformStream(ret)) {
            var _ret;
            ret = makeAsyncIterable((_ret = ret) === null || _ret === void 0 ? void 0 : _ret.readable);
          } else {
            ret = makeAsyncIterable(ret);
          }
          ret = stream(ret, {
            signal
          });
          if (reading) {
            if (!isIterable(ret, true)) {
              throw new ERR_INVALID_RETURN_VALUE("AsyncIterable", `transform[${i - 1}]`, ret);
            }
          } else {
            var _ret2;
            if (!PassThrough) {
              PassThrough = require_passthrough();
            }
            const pt = new PassThrough({
              objectMode: true
            });
            const then = (_ret2 = ret) === null || _ret2 === void 0 ? void 0 : _ret2.then;
            if (typeof then === "function") {
              finishCount++;
              then.call(
                ret,
                (val) => {
                  value = val;
                  if (val != null) {
                    pt.write(val);
                  }
                  if (end) {
                    pt.end();
                  }
                  process2.nextTick(finish);
                },
                (err) => {
                  pt.destroy(err);
                  process2.nextTick(finish, err);
                }
              );
            } else if (isIterable(ret, true)) {
              finishCount++;
              pumpToNode(ret, pt, finish, {
                end
              });
            } else if (isReadableStream(ret) || isTransformStream(ret)) {
              const toRead = ret.readable || ret;
              finishCount++;
              pumpToNode(toRead, pt, finish, {
                end
              });
            } else {
              throw new ERR_INVALID_RETURN_VALUE("AsyncIterable or Promise", "destination", ret);
            }
            ret = pt;
            const { destroy, cleanup } = destroyer(ret, false, true);
            destroys.push(destroy);
            if (isLastStream) {
              lastStreamCleanup.push(cleanup);
            }
          }
        } else if (isNodeStream(stream)) {
          if (isReadableNodeStream(ret)) {
            finishCount += 2;
            const cleanup = pipe(ret, stream, finish, {
              end
            });
            if (isReadable(stream) && isLastStream) {
              lastStreamCleanup.push(cleanup);
            }
          } else if (isTransformStream(ret) || isReadableStream(ret)) {
            const toRead = ret.readable || ret;
            finishCount++;
            pumpToNode(toRead, stream, finish, {
              end
            });
          } else if (isIterable(ret)) {
            finishCount++;
            pumpToNode(ret, stream, finish, {
              end
            });
          } else {
            throw new ERR_INVALID_ARG_TYPE(
              "val",
              ["Readable", "Iterable", "AsyncIterable", "ReadableStream", "TransformStream"],
              ret
            );
          }
          ret = stream;
        } else if (isWebStream(stream)) {
          if (isReadableNodeStream(ret)) {
            finishCount++;
            pumpToWeb(makeAsyncIterable(ret), stream, finish, {
              end
            });
          } else if (isReadableStream(ret) || isIterable(ret)) {
            finishCount++;
            pumpToWeb(ret, stream, finish, {
              end
            });
          } else if (isTransformStream(ret)) {
            finishCount++;
            pumpToWeb(ret.readable, stream, finish, {
              end
            });
          } else {
            throw new ERR_INVALID_ARG_TYPE(
              "val",
              ["Readable", "Iterable", "AsyncIterable", "ReadableStream", "TransformStream"],
              ret
            );
          }
          ret = stream;
        } else {
          ret = Duplex.from(stream);
        }
      }
      if (signal !== null && signal !== void 0 && signal.aborted || outerSignal !== null && outerSignal !== void 0 && outerSignal.aborted) {
        process2.nextTick(abort);
      }
      return ret;
    }
    function pipe(src, dst, finish, { end }) {
      let ended = false;
      dst.on("close", () => {
        if (!ended) {
          finish(new ERR_STREAM_PREMATURE_CLOSE());
        }
      });
      src.pipe(dst, {
        end: false
      });
      if (end) {
        let endFn2 = function() {
          ended = true;
          dst.end();
        };
        var endFn = endFn2;
        if (isReadableFinished(src)) {
          process2.nextTick(endFn2);
        } else {
          src.once("end", endFn2);
        }
      } else {
        finish();
      }
      eos(
        src,
        {
          readable: true,
          writable: false
        },
        (err) => {
          const rState = src._readableState;
          if (err && err.code === "ERR_STREAM_PREMATURE_CLOSE" && rState && rState.ended && !rState.errored && !rState.errorEmitted) {
            src.once("end", finish).once("error", finish);
          } else {
            finish(err);
          }
        }
      );
      return eos(
        dst,
        {
          readable: false,
          writable: true
        },
        finish
      );
    }
    module2.exports = {
      pipelineImpl,
      pipeline
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/compose.js
var require_compose = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/compose.js"(exports2, module2) {
    "use strict";
    var { pipeline } = require_pipeline();
    var Duplex = require_duplex();
    var { destroyer } = require_destroy();
    var {
      isNodeStream,
      isReadable,
      isWritable,
      isWebStream,
      isTransformStream,
      isWritableStream,
      isReadableStream
    } = require_utils();
    var {
      AbortError,
      codes: { ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS }
    } = require_errors();
    var eos = require_end_of_stream();
    module2.exports = function compose(...streams) {
      if (streams.length === 0) {
        throw new ERR_MISSING_ARGS("streams");
      }
      if (streams.length === 1) {
        return Duplex.from(streams[0]);
      }
      const orgStreams = [...streams];
      if (typeof streams[0] === "function") {
        streams[0] = Duplex.from(streams[0]);
      }
      if (typeof streams[streams.length - 1] === "function") {
        const idx = streams.length - 1;
        streams[idx] = Duplex.from(streams[idx]);
      }
      for (let n = 0; n < streams.length; ++n) {
        if (!isNodeStream(streams[n]) && !isWebStream(streams[n])) {
          continue;
        }
        if (n < streams.length - 1 && !(isReadable(streams[n]) || isReadableStream(streams[n]) || isTransformStream(streams[n]))) {
          throw new ERR_INVALID_ARG_VALUE(`streams[${n}]`, orgStreams[n], "must be readable");
        }
        if (n > 0 && !(isWritable(streams[n]) || isWritableStream(streams[n]) || isTransformStream(streams[n]))) {
          throw new ERR_INVALID_ARG_VALUE(`streams[${n}]`, orgStreams[n], "must be writable");
        }
      }
      let ondrain;
      let onfinish;
      let onreadable;
      let onclose;
      let d;
      function onfinished(err) {
        const cb = onclose;
        onclose = null;
        if (cb) {
          cb(err);
        } else if (err) {
          d.destroy(err);
        } else if (!readable && !writable) {
          d.destroy();
        }
      }
      const head = streams[0];
      const tail = pipeline(streams, onfinished);
      const writable = !!(isWritable(head) || isWritableStream(head) || isTransformStream(head));
      const readable = !!(isReadable(tail) || isReadableStream(tail) || isTransformStream(tail));
      d = new Duplex({
        // TODO (ronag): highWaterMark?
        writableObjectMode: !!(head !== null && head !== void 0 && head.writableObjectMode),
        readableObjectMode: !!(tail !== null && tail !== void 0 && tail.readableObjectMode),
        writable,
        readable
      });
      if (writable) {
        if (isNodeStream(head)) {
          d._write = function(chunk, encoding, callback) {
            if (head.write(chunk, encoding)) {
              callback();
            } else {
              ondrain = callback;
            }
          };
          d._final = function(callback) {
            head.end();
            onfinish = callback;
          };
          head.on("drain", function() {
            if (ondrain) {
              const cb = ondrain;
              ondrain = null;
              cb();
            }
          });
        } else if (isWebStream(head)) {
          const writable2 = isTransformStream(head) ? head.writable : head;
          const writer = writable2.getWriter();
          d._write = async function(chunk, encoding, callback) {
            try {
              await writer.ready;
              writer.write(chunk).catch(() => {
              });
              callback();
            } catch (err) {
              callback(err);
            }
          };
          d._final = async function(callback) {
            try {
              await writer.ready;
              writer.close().catch(() => {
              });
              onfinish = callback;
            } catch (err) {
              callback(err);
            }
          };
        }
        const toRead = isTransformStream(tail) ? tail.readable : tail;
        eos(toRead, () => {
          if (onfinish) {
            const cb = onfinish;
            onfinish = null;
            cb();
          }
        });
      }
      if (readable) {
        if (isNodeStream(tail)) {
          tail.on("readable", function() {
            if (onreadable) {
              const cb = onreadable;
              onreadable = null;
              cb();
            }
          });
          tail.on("end", function() {
            d.push(null);
          });
          d._read = function() {
            while (true) {
              const buf = tail.read();
              if (buf === null) {
                onreadable = d._read;
                return;
              }
              if (!d.push(buf)) {
                return;
              }
            }
          };
        } else if (isWebStream(tail)) {
          const readable2 = isTransformStream(tail) ? tail.readable : tail;
          const reader = readable2.getReader();
          d._read = async function() {
            while (true) {
              try {
                const { value, done } = await reader.read();
                if (!d.push(value)) {
                  return;
                }
                if (done) {
                  d.push(null);
                  return;
                }
              } catch {
                return;
              }
            }
          };
        }
      }
      d._destroy = function(err, callback) {
        if (!err && onclose !== null) {
          err = new AbortError();
        }
        onreadable = null;
        ondrain = null;
        onfinish = null;
        if (onclose === null) {
          callback(err);
        } else {
          onclose = callback;
          if (isNodeStream(tail)) {
            destroyer(tail, err);
          }
        }
      };
      return d;
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/operators.js
var require_operators = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/internal/streams/operators.js"(exports2, module2) {
    "use strict";
    var AbortController = globalThis.AbortController || require_abort_controller().AbortController;
    var {
      codes: { ERR_INVALID_ARG_VALUE, ERR_INVALID_ARG_TYPE, ERR_MISSING_ARGS, ERR_OUT_OF_RANGE },
      AbortError
    } = require_errors();
    var { validateAbortSignal, validateInteger, validateObject } = require_validators();
    var kWeakHandler = require_primordials().Symbol("kWeak");
    var kResistStopPropagation = require_primordials().Symbol("kResistStopPropagation");
    var { finished } = require_end_of_stream();
    var staticCompose = require_compose();
    var { addAbortSignalNoValidate } = require_add_abort_signal();
    var { isWritable, isNodeStream } = require_utils();
    var { deprecate } = require_util();
    var {
      ArrayPrototypePush,
      Boolean: Boolean2,
      MathFloor,
      Number: Number2,
      NumberIsNaN,
      Promise: Promise2,
      PromiseReject,
      PromiseResolve,
      PromisePrototypeThen,
      Symbol: Symbol2
    } = require_primordials();
    var kEmpty = Symbol2("kEmpty");
    var kEof = Symbol2("kEof");
    function compose(stream, options) {
      if (options != null) {
        validateObject(options, "options");
      }
      if ((options === null || options === void 0 ? void 0 : options.signal) != null) {
        validateAbortSignal(options.signal, "options.signal");
      }
      if (isNodeStream(stream) && !isWritable(stream)) {
        throw new ERR_INVALID_ARG_VALUE("stream", stream, "must be writable");
      }
      const composedStream = staticCompose(this, stream);
      if (options !== null && options !== void 0 && options.signal) {
        addAbortSignalNoValidate(options.signal, composedStream);
      }
      return composedStream;
    }
    function map(fn, options) {
      if (typeof fn !== "function") {
        throw new ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
      }
      if (options != null) {
        validateObject(options, "options");
      }
      if ((options === null || options === void 0 ? void 0 : options.signal) != null) {
        validateAbortSignal(options.signal, "options.signal");
      }
      let concurrency = 1;
      if ((options === null || options === void 0 ? void 0 : options.concurrency) != null) {
        concurrency = MathFloor(options.concurrency);
      }
      let highWaterMark = concurrency - 1;
      if ((options === null || options === void 0 ? void 0 : options.highWaterMark) != null) {
        highWaterMark = MathFloor(options.highWaterMark);
      }
      validateInteger(concurrency, "options.concurrency", 1);
      validateInteger(highWaterMark, "options.highWaterMark", 0);
      highWaterMark += concurrency;
      return async function* map2() {
        const signal = require_util().AbortSignalAny(
          [options === null || options === void 0 ? void 0 : options.signal].filter(Boolean2)
        );
        const stream = this;
        const queue = [];
        const signalOpt = {
          signal
        };
        let next;
        let resume;
        let done = false;
        let cnt = 0;
        function onCatch() {
          done = true;
          afterItemProcessed();
        }
        function afterItemProcessed() {
          cnt -= 1;
          maybeResume();
        }
        function maybeResume() {
          if (resume && !done && cnt < concurrency && queue.length < highWaterMark) {
            resume();
            resume = null;
          }
        }
        async function pump() {
          try {
            for await (let val of stream) {
              if (done) {
                return;
              }
              if (signal.aborted) {
                throw new AbortError();
              }
              try {
                val = fn(val, signalOpt);
                if (val === kEmpty) {
                  continue;
                }
                val = PromiseResolve(val);
              } catch (err) {
                val = PromiseReject(err);
              }
              cnt += 1;
              PromisePrototypeThen(val, afterItemProcessed, onCatch);
              queue.push(val);
              if (next) {
                next();
                next = null;
              }
              if (!done && (queue.length >= highWaterMark || cnt >= concurrency)) {
                await new Promise2((resolve) => {
                  resume = resolve;
                });
              }
            }
            queue.push(kEof);
          } catch (err) {
            const val = PromiseReject(err);
            PromisePrototypeThen(val, afterItemProcessed, onCatch);
            queue.push(val);
          } finally {
            done = true;
            if (next) {
              next();
              next = null;
            }
          }
        }
        pump();
        try {
          while (true) {
            while (queue.length > 0) {
              const val = await queue[0];
              if (val === kEof) {
                return;
              }
              if (signal.aborted) {
                throw new AbortError();
              }
              if (val !== kEmpty) {
                yield val;
              }
              queue.shift();
              maybeResume();
            }
            await new Promise2((resolve) => {
              next = resolve;
            });
          }
        } finally {
          done = true;
          if (resume) {
            resume();
            resume = null;
          }
        }
      }.call(this);
    }
    function asIndexedPairs(options = void 0) {
      if (options != null) {
        validateObject(options, "options");
      }
      if ((options === null || options === void 0 ? void 0 : options.signal) != null) {
        validateAbortSignal(options.signal, "options.signal");
      }
      return async function* asIndexedPairs2() {
        let index2 = 0;
        for await (const val of this) {
          var _options$signal;
          if (options !== null && options !== void 0 && (_options$signal = options.signal) !== null && _options$signal !== void 0 && _options$signal.aborted) {
            throw new AbortError({
              cause: options.signal.reason
            });
          }
          yield [index2++, val];
        }
      }.call(this);
    }
    async function some(fn, options = void 0) {
      for await (const unused of filter.call(this, fn, options)) {
        return true;
      }
      return false;
    }
    async function every(fn, options = void 0) {
      if (typeof fn !== "function") {
        throw new ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
      }
      return !await some.call(
        this,
        async (...args) => {
          return !await fn(...args);
        },
        options
      );
    }
    async function find(fn, options) {
      for await (const result of filter.call(this, fn, options)) {
        return result;
      }
      return void 0;
    }
    async function forEach(fn, options) {
      if (typeof fn !== "function") {
        throw new ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
      }
      async function forEachFn(value, options2) {
        await fn(value, options2);
        return kEmpty;
      }
      for await (const unused of map.call(this, forEachFn, options)) ;
    }
    function filter(fn, options) {
      if (typeof fn !== "function") {
        throw new ERR_INVALID_ARG_TYPE("fn", ["Function", "AsyncFunction"], fn);
      }
      async function filterFn(value, options2) {
        if (await fn(value, options2)) {
          return value;
        }
        return kEmpty;
      }
      return map.call(this, filterFn, options);
    }
    var ReduceAwareErrMissingArgs = class extends ERR_MISSING_ARGS {
      constructor() {
        super("reduce");
        this.message = "Reduce of an empty stream requires an initial value";
      }
    };
    async function reduce(reducer, initialValue, options) {
      var _options$signal2;
      if (typeof reducer !== "function") {
        throw new ERR_INVALID_ARG_TYPE("reducer", ["Function", "AsyncFunction"], reducer);
      }
      if (options != null) {
        validateObject(options, "options");
      }
      if ((options === null || options === void 0 ? void 0 : options.signal) != null) {
        validateAbortSignal(options.signal, "options.signal");
      }
      let hasInitialValue = arguments.length > 1;
      if (options !== null && options !== void 0 && (_options$signal2 = options.signal) !== null && _options$signal2 !== void 0 && _options$signal2.aborted) {
        const err = new AbortError(void 0, {
          cause: options.signal.reason
        });
        this.once("error", () => {
        });
        await finished(this.destroy(err));
        throw err;
      }
      const ac = new AbortController();
      const signal = ac.signal;
      if (options !== null && options !== void 0 && options.signal) {
        const opts = {
          once: true,
          [kWeakHandler]: this,
          [kResistStopPropagation]: true
        };
        options.signal.addEventListener("abort", () => ac.abort(), opts);
      }
      let gotAnyItemFromStream = false;
      try {
        for await (const value of this) {
          var _options$signal3;
          gotAnyItemFromStream = true;
          if (options !== null && options !== void 0 && (_options$signal3 = options.signal) !== null && _options$signal3 !== void 0 && _options$signal3.aborted) {
            throw new AbortError();
          }
          if (!hasInitialValue) {
            initialValue = value;
            hasInitialValue = true;
          } else {
            initialValue = await reducer(initialValue, value, {
              signal
            });
          }
        }
        if (!gotAnyItemFromStream && !hasInitialValue) {
          throw new ReduceAwareErrMissingArgs();
        }
      } finally {
        ac.abort();
      }
      return initialValue;
    }
    async function toArray(options) {
      if (options != null) {
        validateObject(options, "options");
      }
      if ((options === null || options === void 0 ? void 0 : options.signal) != null) {
        validateAbortSignal(options.signal, "options.signal");
      }
      const result = [];
      for await (const val of this) {
        var _options$signal4;
        if (options !== null && options !== void 0 && (_options$signal4 = options.signal) !== null && _options$signal4 !== void 0 && _options$signal4.aborted) {
          throw new AbortError(void 0, {
            cause: options.signal.reason
          });
        }
        ArrayPrototypePush(result, val);
      }
      return result;
    }
    function flatMap(fn, options) {
      const values = map.call(this, fn, options);
      return async function* flatMap2() {
        for await (const val of values) {
          yield* val;
        }
      }.call(this);
    }
    function toIntegerOrInfinity(number) {
      number = Number2(number);
      if (NumberIsNaN(number)) {
        return 0;
      }
      if (number < 0) {
        throw new ERR_OUT_OF_RANGE("number", ">= 0", number);
      }
      return number;
    }
    function drop(number, options = void 0) {
      if (options != null) {
        validateObject(options, "options");
      }
      if ((options === null || options === void 0 ? void 0 : options.signal) != null) {
        validateAbortSignal(options.signal, "options.signal");
      }
      number = toIntegerOrInfinity(number);
      return async function* drop2() {
        var _options$signal5;
        if (options !== null && options !== void 0 && (_options$signal5 = options.signal) !== null && _options$signal5 !== void 0 && _options$signal5.aborted) {
          throw new AbortError();
        }
        for await (const val of this) {
          var _options$signal6;
          if (options !== null && options !== void 0 && (_options$signal6 = options.signal) !== null && _options$signal6 !== void 0 && _options$signal6.aborted) {
            throw new AbortError();
          }
          if (number-- <= 0) {
            yield val;
          }
        }
      }.call(this);
    }
    function take(number, options = void 0) {
      if (options != null) {
        validateObject(options, "options");
      }
      if ((options === null || options === void 0 ? void 0 : options.signal) != null) {
        validateAbortSignal(options.signal, "options.signal");
      }
      number = toIntegerOrInfinity(number);
      return async function* take2() {
        var _options$signal7;
        if (options !== null && options !== void 0 && (_options$signal7 = options.signal) !== null && _options$signal7 !== void 0 && _options$signal7.aborted) {
          throw new AbortError();
        }
        for await (const val of this) {
          var _options$signal8;
          if (options !== null && options !== void 0 && (_options$signal8 = options.signal) !== null && _options$signal8 !== void 0 && _options$signal8.aborted) {
            throw new AbortError();
          }
          if (number-- > 0) {
            yield val;
          }
          if (number <= 0) {
            return;
          }
        }
      }.call(this);
    }
    module2.exports.streamReturningOperators = {
      asIndexedPairs: deprecate(asIndexedPairs, "readable.asIndexedPairs will be removed in a future version."),
      drop,
      filter,
      flatMap,
      map,
      take,
      compose
    };
    module2.exports.promiseReturningOperators = {
      every,
      forEach,
      reduce,
      toArray,
      some,
      find
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/stream/promises.js
var require_promises = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/stream/promises.js"(exports2, module2) {
    "use strict";
    var { ArrayPrototypePop, Promise: Promise2 } = require_primordials();
    var { isIterable, isNodeStream, isWebStream } = require_utils();
    var { pipelineImpl: pl } = require_pipeline();
    var { finished } = require_end_of_stream();
    require_stream();
    function pipeline(...streams) {
      return new Promise2((resolve, reject) => {
        let signal;
        let end;
        const lastArg = streams[streams.length - 1];
        if (lastArg && typeof lastArg === "object" && !isNodeStream(lastArg) && !isIterable(lastArg) && !isWebStream(lastArg)) {
          const options = ArrayPrototypePop(streams);
          signal = options.signal;
          end = options.end;
        }
        pl(
          streams,
          (err, value) => {
            if (err) {
              reject(err);
            } else {
              resolve(value);
            }
          },
          {
            signal,
            end
          }
        );
      });
    }
    module2.exports = {
      finished,
      pipeline
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/stream.js
var require_stream = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/stream.js"(exports2, module2) {
    "use strict";
    var { Buffer: Buffer2 } = require("buffer");
    var { ObjectDefineProperty, ObjectKeys, ReflectApply } = require_primordials();
    var {
      promisify: { custom: customPromisify }
    } = require_util();
    var { streamReturningOperators, promiseReturningOperators } = require_operators();
    var {
      codes: { ERR_ILLEGAL_CONSTRUCTOR }
    } = require_errors();
    var compose = require_compose();
    var { setDefaultHighWaterMark, getDefaultHighWaterMark } = require_state();
    var { pipeline } = require_pipeline();
    var { destroyer } = require_destroy();
    var eos = require_end_of_stream();
    var promises = require_promises();
    var utils = require_utils();
    var Stream = module2.exports = require_legacy().Stream;
    Stream.isDestroyed = utils.isDestroyed;
    Stream.isDisturbed = utils.isDisturbed;
    Stream.isErrored = utils.isErrored;
    Stream.isReadable = utils.isReadable;
    Stream.isWritable = utils.isWritable;
    Stream.Readable = require_readable();
    for (const key of ObjectKeys(streamReturningOperators)) {
      let fn = function(...args) {
        if (new.target) {
          throw ERR_ILLEGAL_CONSTRUCTOR();
        }
        return Stream.Readable.from(ReflectApply(op, this, args));
      };
      const op = streamReturningOperators[key];
      ObjectDefineProperty(fn, "name", {
        __proto__: null,
        value: op.name
      });
      ObjectDefineProperty(fn, "length", {
        __proto__: null,
        value: op.length
      });
      ObjectDefineProperty(Stream.Readable.prototype, key, {
        __proto__: null,
        value: fn,
        enumerable: false,
        configurable: true,
        writable: true
      });
    }
    for (const key of ObjectKeys(promiseReturningOperators)) {
      let fn = function(...args) {
        if (new.target) {
          throw ERR_ILLEGAL_CONSTRUCTOR();
        }
        return ReflectApply(op, this, args);
      };
      const op = promiseReturningOperators[key];
      ObjectDefineProperty(fn, "name", {
        __proto__: null,
        value: op.name
      });
      ObjectDefineProperty(fn, "length", {
        __proto__: null,
        value: op.length
      });
      ObjectDefineProperty(Stream.Readable.prototype, key, {
        __proto__: null,
        value: fn,
        enumerable: false,
        configurable: true,
        writable: true
      });
    }
    Stream.Writable = require_writable();
    Stream.Duplex = require_duplex();
    Stream.Transform = require_transform();
    Stream.PassThrough = require_passthrough();
    Stream.pipeline = pipeline;
    var { addAbortSignal } = require_add_abort_signal();
    Stream.addAbortSignal = addAbortSignal;
    Stream.finished = eos;
    Stream.destroy = destroyer;
    Stream.compose = compose;
    Stream.setDefaultHighWaterMark = setDefaultHighWaterMark;
    Stream.getDefaultHighWaterMark = getDefaultHighWaterMark;
    ObjectDefineProperty(Stream, "promises", {
      __proto__: null,
      configurable: true,
      enumerable: true,
      get() {
        return promises;
      }
    });
    ObjectDefineProperty(pipeline, customPromisify, {
      __proto__: null,
      enumerable: true,
      get() {
        return promises.pipeline;
      }
    });
    ObjectDefineProperty(eos, customPromisify, {
      __proto__: null,
      enumerable: true,
      get() {
        return promises.finished;
      }
    });
    Stream.Stream = Stream;
    Stream._isUint8Array = function isUint8Array(value) {
      return value instanceof Uint8Array;
    };
    Stream._uint8ArrayToBuffer = function _uint8ArrayToBuffer(chunk) {
      return Buffer2.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    };
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/index.js
var require_ours = __commonJS({
  "Local/\u4E34\u65F6/test_isogit_bundle/node_modules/isomorphic-git/node_modules/readable-stream/lib/ours/index.js"(exports2, module2) {
    "use strict";
    var Stream = require("stream");
    if (Stream && process.env.READABLE_STREAM === "disable") {
      const promises = Stream.promises;
      module2.exports._uint8ArrayToBuffer = Stream._uint8ArrayToBuffer;
      module2.exports._isUint8Array = Stream._isUint8Array;
      module2.exports.isDisturbed = Stream.isDisturbed;
      module2.exports.isErrored = Stream.isErrored;
      module2.exports.isReadable = Stream.isReadable;
      module2.exports.Readable = Stream.Readable;
      module2.exports.Writable = Stream.Writable;
      module2.exports.Duplex = Stream.Duplex;
      module2.exports.Transform = Stream.Transform;
      module2.exports.PassThrough = Stream.PassThrough;
      module2.exports.addAbortSignal = Stream.addAbortSignal;
      module2.exports.finished = Stream.finished;
      module2.exports.destroy = Stream.destroy;
      module2.exports.pipeline = Stream.pipeline;
      module2.exports.compose = Stream.compose;
      Object.defineProperty(Stream, "promises", {
        configurable: true,
        enumerable: true,
        get() {
          return promises;
        }
      });
      module2.exports.Stream = Stream.Stream;
    } else {
      const CustomStream = require_stream();
      const promises = require_promises();
      const originalDestroy = CustomStream.Readable.destroy;
      module2.exports = CustomStream.Readable;
      module2.exports._uint8ArrayToBuffer = CustomStream._uint8ArrayToBuffer;
      module2.exports._isUint8Array = CustomStream._isUint8Array;
      module2.exports.isDisturbed = CustomStream.isDisturbed;
      module2.exports.isErrored = CustomStream.isErrored;
      module2.exports.isReadable = CustomStream.isReadable;
      module2.exports.Readable = CustomStream.Readable;
      module2.exports.Writable = CustomStream.Writable;
      module2.exports.Duplex = CustomStream.Duplex;
      module2.exports.Transform = CustomStream.Transform;
      module2.exports.PassThrough = CustomStream.PassThrough;
      module2.exports.addAbortSignal = CustomStream.addAbortSignal;
      module2.exports.finished = CustomStream.finished;
      module2.exports.destroy = CustomStream.destroy;
      module2.exports.destroy = originalDestroy;
      module2.exports.pipeline = CustomStream.pipeline;
      module2.exports.compose = CustomStream.compose;
      Object.defineProperty(CustomStream, "promises", {
        configurable: true,
        enumerable: true,
        get() {
          return promises;
        }
      });
      module2.exports.Stream = CustomStream.Stream;
    }
    module2.exports.default = module2.exports;
  }
});

// Local/临时/test_isogit_bundle/node_modules/isomorphic-git/http/node/index.cjs
Object.defineProperty(exports, "__esModule", { value: true });
function _interopDefault(ex) {
  return ex && typeof ex === "object" && "default" in ex ? ex["default"] : ex;
}
var get = _interopDefault(require_simple_get());
function fromValue(value) {
  let queue = [value];
  return {
    next() {
      return Promise.resolve({ done: queue.length === 0, value: queue.pop() });
    },
    return() {
      queue = [];
      return {};
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
function getIterator(iterable) {
  if (iterable[Symbol.asyncIterator]) {
    return iterable[Symbol.asyncIterator]();
  }
  if (iterable[Symbol.iterator]) {
    return iterable[Symbol.iterator]();
  }
  if (iterable.next) {
    return iterable;
  }
  return fromValue(iterable);
}
async function forAwait(iterable, cb) {
  const iter = getIterator(iterable);
  while (true) {
    const { value, done } = await iter.next();
    if (value) await cb(value);
    if (done) break;
  }
  if (iter.return) iter.return();
}
function asyncIteratorToStream(iter) {
  const { PassThrough } = require_ours();
  const stream = new PassThrough();
  setTimeout(async () => {
    await forAwait(iter, (chunk) => stream.write(chunk));
    stream.end();
  }, 1);
  return stream;
}
async function collect(iterable) {
  let size = 0;
  const buffers = [];
  await forAwait(iterable, (value) => {
    buffers.push(value);
    size += value.byteLength;
  });
  const result = new Uint8Array(size);
  let nextIndex = 0;
  for (const buffer of buffers) {
    result.set(buffer, nextIndex);
    nextIndex += buffer.byteLength;
  }
  return result;
}
function fromNodeStream(stream) {
  const asyncIterator = Object.getOwnPropertyDescriptor(
    stream,
    Symbol.asyncIterator
  );
  if (asyncIterator && asyncIterator.enumerable) {
    return stream;
  }
  let ended = false;
  const queue = [];
  let defer = {};
  stream.on("data", (chunk) => {
    queue.push(chunk);
    if (defer.resolve) {
      defer.resolve({ value: queue.shift(), done: false });
      defer = {};
    }
  });
  stream.on("error", (err) => {
    if (defer.reject) {
      defer.reject(err);
      defer = {};
    }
  });
  stream.on("end", () => {
    ended = true;
    if (defer.resolve) {
      defer.resolve({ done: true });
      defer = {};
    }
  });
  return {
    next() {
      return new Promise((resolve, reject) => {
        if (queue.length === 0 && ended) {
          return resolve({ done: true });
        } else if (queue.length > 0) {
          return resolve({ value: queue.shift(), done: false });
        } else if (queue.length === 0 && !ended) {
          defer = { resolve, reject };
        }
      });
    },
    return() {
      stream.removeAllListeners();
      if (stream.destroy) stream.destroy();
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
async function request({
  onProgress,
  url,
  method = "GET",
  headers = {},
  agent,
  body
}) {
  if (body && Array.isArray(body)) {
    body = Buffer.from(await collect(body));
  } else if (body) {
    body = asyncIteratorToStream(body);
  }
  return new Promise((resolve, reject) => {
    get(
      {
        url,
        method,
        headers,
        agent,
        body
      },
      (err, res) => {
        if (err) return reject(err);
        try {
          const iter = fromNodeStream(res);
          resolve({
            url: res.url,
            method: res.method,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            body: iter,
            headers: res.headers
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}
var index = { request };
exports.default = index;
exports.request = request;
/*! Bundled license information:

simple-concat/index.js:
  (*! simple-concat. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> *)

simple-get/index.js:
  (*! simple-get. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> *)

safe-buffer/index.js:
  (*! safe-buffer. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> *)
*/
