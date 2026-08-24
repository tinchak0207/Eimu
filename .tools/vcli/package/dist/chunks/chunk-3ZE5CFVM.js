import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  __commonJS,
  __require
} from "./chunk-TZ2YI2VH.js";

// ../../node_modules/.pnpm/double-ended-queue@2.1.0-0/node_modules/double-ended-queue/js/deque.js
var require_deque = __commonJS({
  "../../node_modules/.pnpm/double-ended-queue@2.1.0-0/node_modules/double-ended-queue/js/deque.js"(exports, module) {
    "use strict";
    function Deque(capacity) {
      this._capacity = getCapacity(capacity);
      this._length = 0;
      this._front = 0;
      if (isArray(capacity)) {
        var len = capacity.length;
        for (var i = 0; i < len; ++i) {
          this[i] = capacity[i];
        }
        this._length = len;
      }
    }
    Deque.prototype.toArray = function Deque$toArray() {
      var len = this._length;
      var ret = new Array(len);
      var front = this._front;
      var capacity = this._capacity;
      for (var j = 0; j < len; ++j) {
        ret[j] = this[front + j & capacity - 1];
      }
      return ret;
    };
    Deque.prototype.push = function Deque$push(item) {
      var argsLength = arguments.length;
      var length = this._length;
      if (argsLength > 1) {
        var capacity = this._capacity;
        if (length + argsLength > capacity) {
          for (var i = 0; i < argsLength; ++i) {
            this._checkCapacity(length + 1);
            var j = this._front + length & this._capacity - 1;
            this[j] = arguments[i];
            length++;
            this._length = length;
          }
          return length;
        } else {
          var j = this._front;
          for (var i = 0; i < argsLength; ++i) {
            this[j + length & capacity - 1] = arguments[i];
            j++;
          }
          this._length = length + argsLength;
          return length + argsLength;
        }
      }
      if (argsLength === 0)
        return length;
      this._checkCapacity(length + 1);
      var i = this._front + length & this._capacity - 1;
      this[i] = item;
      this._length = length + 1;
      return length + 1;
    };
    Deque.prototype.pop = function Deque$pop() {
      var length = this._length;
      if (length === 0) {
        return void 0;
      }
      var i = this._front + length - 1 & this._capacity - 1;
      var ret = this[i];
      this[i] = void 0;
      this._length = length - 1;
      return ret;
    };
    Deque.prototype.shift = function Deque$shift() {
      var length = this._length;
      if (length === 0) {
        return void 0;
      }
      var front = this._front;
      var ret = this[front];
      this[front] = void 0;
      this._front = front + 1 & this._capacity - 1;
      this._length = length - 1;
      return ret;
    };
    Deque.prototype.unshift = function Deque$unshift(item) {
      var length = this._length;
      var argsLength = arguments.length;
      if (argsLength > 1) {
        var capacity = this._capacity;
        if (length + argsLength > capacity) {
          for (var i = argsLength - 1; i >= 0; i--) {
            this._checkCapacity(length + 1);
            var capacity = this._capacity;
            var j = (this._front - 1 & capacity - 1 ^ capacity) - capacity;
            this[j] = arguments[i];
            length++;
            this._length = length;
            this._front = j;
          }
          return length;
        } else {
          var front = this._front;
          for (var i = argsLength - 1; i >= 0; i--) {
            var j = (front - 1 & capacity - 1 ^ capacity) - capacity;
            this[j] = arguments[i];
            front = j;
          }
          this._front = front;
          this._length = length + argsLength;
          return length + argsLength;
        }
      }
      if (argsLength === 0)
        return length;
      this._checkCapacity(length + 1);
      var capacity = this._capacity;
      var i = (this._front - 1 & capacity - 1 ^ capacity) - capacity;
      this[i] = item;
      this._length = length + 1;
      this._front = i;
      return length + 1;
    };
    Deque.prototype.peekBack = function Deque$peekBack() {
      var length = this._length;
      if (length === 0) {
        return void 0;
      }
      var index = this._front + length - 1 & this._capacity - 1;
      return this[index];
    };
    Deque.prototype.peekFront = function Deque$peekFront() {
      if (this._length === 0) {
        return void 0;
      }
      return this[this._front];
    };
    Deque.prototype.get = function Deque$get(index) {
      var i = index;
      if (i !== (i | 0)) {
        return void 0;
      }
      var len = this._length;
      if (i < 0) {
        i = i + len;
      }
      if (i < 0 || i >= len) {
        return void 0;
      }
      return this[this._front + i & this._capacity - 1];
    };
    Deque.prototype.isEmpty = function Deque$isEmpty() {
      return this._length === 0;
    };
    Deque.prototype.clear = function Deque$clear() {
      var len = this._length;
      var front = this._front;
      var capacity = this._capacity;
      for (var j = 0; j < len; ++j) {
        this[front + j & capacity - 1] = void 0;
      }
      this._length = 0;
      this._front = 0;
    };
    Deque.prototype.toString = function Deque$toString() {
      return this.toArray().toString();
    };
    Deque.prototype.valueOf = Deque.prototype.toString;
    Deque.prototype.removeFront = Deque.prototype.shift;
    Deque.prototype.removeBack = Deque.prototype.pop;
    Deque.prototype.insertFront = Deque.prototype.unshift;
    Deque.prototype.insertBack = Deque.prototype.push;
    Deque.prototype.enqueue = Deque.prototype.push;
    Deque.prototype.dequeue = Deque.prototype.shift;
    Deque.prototype.toJSON = Deque.prototype.toArray;
    Object.defineProperty(Deque.prototype, "length", {
      get: function() {
        return this._length;
      },
      set: function() {
        throw new RangeError("");
      }
    });
    Deque.prototype._checkCapacity = function Deque$_checkCapacity(size) {
      if (this._capacity < size) {
        this._resizeTo(getCapacity(this._capacity * 1.5 + 16));
      }
    };
    Deque.prototype._resizeTo = function Deque$_resizeTo(capacity) {
      var oldCapacity = this._capacity;
      this._capacity = capacity;
      var front = this._front;
      var length = this._length;
      if (front + length > oldCapacity) {
        var moveItemsCount = front + length & oldCapacity - 1;
        arrayMove(this, 0, this, oldCapacity, moveItemsCount);
      }
    };
    var isArray = Array.isArray;
    function arrayMove(src, srcIndex, dst, dstIndex, len) {
      for (var j = 0; j < len; ++j) {
        dst[j + dstIndex] = src[j + srcIndex];
        src[j + srcIndex] = void 0;
      }
    }
    function pow2AtLeast(n) {
      n = n >>> 0;
      n = n - 1;
      n = n | n >> 1;
      n = n | n >> 2;
      n = n | n >> 4;
      n = n | n >> 8;
      n = n | n >> 16;
      return n + 1;
    }
    function getCapacity(capacity) {
      if (typeof capacity !== "number") {
        if (isArray(capacity)) {
          capacity = capacity.length;
        } else {
          return 16;
        }
      }
      return pow2AtLeast(
        Math.min(
          Math.max(16, capacity),
          1073741824
        )
      );
    }
    module.exports = Deque;
  }
});

// ../../node_modules/.pnpm/async-sema@2.1.4/node_modules/async-sema/index.js
var require_async_sema = __commonJS({
  "../../node_modules/.pnpm/async-sema@2.1.4/node_modules/async-sema/index.js"(exports, module) {
    var EventEmitter = __require("events");
    var util = __require("util");
    var Deque = require_deque();
    var ReleaseEmitter = class extends EventEmitter {
    };
    function isFn(x) {
      return typeof x === "function";
    }
    function defaultInit() {
      return "1";
    }
    var Sema = class {
      constructor(nr, { initFn = defaultInit, pauseFn, resumeFn, capacity = 10 } = {}) {
        if (isFn(pauseFn) ^ isFn(resumeFn)) {
          throw new Error("pauseFn and resumeFn must be both set for pausing");
        }
        this.nrTokens = nr;
        this.free = new Deque(nr);
        this.waiting = new Deque(capacity);
        this.releaseEmitter = new ReleaseEmitter();
        this.noTokens = initFn === defaultInit;
        this.pauseFn = pauseFn;
        this.resumeFn = resumeFn;
        this.releaseEmitter.on("release", (token) => {
          const p = this.waiting.shift();
          if (p) {
            p.resolve(token);
          } else {
            if (this.resumeFn && this.paused) {
              this.paused = false;
              this.resumeFn();
            }
            this.free.push(token);
          }
        });
        for (let i = 0; i < nr; i++) {
          this.free.push(initFn());
        }
      }
      async acquire() {
        let token = this.free.pop();
        if (token) {
          return token;
        }
        return new Promise((resolve, reject) => {
          if (this.pauseFn && !this.paused) {
            this.paused = true;
            this.pauseFn();
          }
          this.waiting.push({ resolve, reject });
        });
      }
      async v() {
        return this.acquire();
      }
      release(token) {
        this.releaseEmitter.emit("release", this.noTokens ? "1" : token);
      }
      p(token) {
        return this.release(token);
      }
      drain() {
        const a = new Array(this.nrTokens);
        for (let i = 0; i < this.nrTokens; i++) {
          a[i] = this.acquire();
        }
        return Promise.all(a);
      }
      nrWaiting() {
        return this.waiting.length;
      }
    };
    Sema.prototype.v = util.deprecate(Sema.prototype.v, "`v()` is deperecated; use `acquire()` instead");
    Sema.prototype.p = util.deprecate(Sema.prototype.p, "`p()` is deprecated; use `release()` instead");
    module.exports = Sema;
  }
});

// src/commands/vcr/permissions/team-refs.ts
var MAX_CONCURRENT_REQUESTS = 10;
function parseTeamRefs(args) {
  const refs = [];
  for (const arg of args) {
    for (const piece of arg.split(",")) {
      const ref = piece.trim();
      if (ref && !refs.includes(ref)) {
        refs.push(ref);
      }
    }
  }
  return refs;
}
function teamRefBody(ref) {
  return ref.startsWith("team_") ? { teamId: ref } : { teamSlug: ref };
}

export {
  require_async_sema,
  MAX_CONCURRENT_REQUESTS,
  parseTeamRefs,
  teamRefBody
};
