/**
 * Universal stub for Node.js built-in modules in browser builds.
 *
 * Server-only packages (AWS SDK, @smithy, proxy-agent, etc.) import from
 * Node built-ins like "stream", "http", "net", etc. These never actually
 * execute in the browser — they're just pulled in transitively.
 *
 * This file provides no-op exports for every name that any of those packages
 * import, so both esbuild (dev) and Rollup (build) can resolve them.
 */

/* eslint-disable @typescript-eslint/no-empty-function */
const noop = () => {};
const noopClass = class {};
const noopObj = Object.create(null);

// stream
export const Readable = noopClass;
export const Writable = noopClass;
export const Transform = noopClass;
export const PassThrough = noopClass;
export const Duplex = noopClass;
export const Stream = noopClass;
export const pipeline = noop;
export const finished = noop;

// http / https
export const Agent = noopClass;
export const Server = noopClass;
export const IncomingMessage = noopClass;
export const ServerResponse = noopClass;
export const ClientRequest = noopClass;
export const OutgoingMessage = noopClass;
export const globalAgent = noopObj;
export const createServer = noop;
export const request = noop;
export const get = noop;

// net / tls
export const Socket = noopClass;
export const TLSSocket = noopClass;
export const connect = noop;
export const createConnection = noop;
export const isIP = noop;
export const isIPv4 = noop;
export const isIPv6 = noop;

// dns
export const resolve4 = noop;
export const resolve6 = noop;
export const lookup = noop;
export const Resolver = noopClass;

// crypto
export const createHash = noop;
export const createHmac = noop;
export const createSign = noop;
export const createVerify = noop;
export const randomBytes = noop;
export const randomUUID = noop;
export const createCipheriv = noop;
export const createDecipheriv = noop;
export const getHashes = noop;
export const timingSafeEqual = noop;

// fs
export const createReadStream = noop;
export const createWriteStream = noop;
export const readFileSync = noop;
export const writeFileSync = noop;
export const existsSync = noop;
export const mkdirSync = noop;
export const readdirSync = noop;
export const statSync = noop;
export const unlinkSync = noop;
export const readFile = noop;
export const writeFile = noop;
export const stat = noop;
export const lstat = noop;
export const mkdir = noop;
export const access = noop;
export const unlink = noop;
export const rename = noop;
export const realpath = noop;
export const readdir = noop;
export const chmod = noop;
export const chown = noop;
export const promises = noopObj;
export const constants = noopObj;

// path
export const join = noop;
export const resolve = noop;
export const dirname = noop;
export const basename = noop;
export const extname = noop;
export const isAbsolute = noop;
export const relative = noop;
export const normalize = noop;
export const parse = noop;
export const format = noop;
export const sep = "/";
export const delimiter = ":";
export const posix = noopObj;
export const win32 = noopObj;

// os
export const platform = "browser";
export const arch = "wasm";
export const homedir = noop;
export const tmpdir = noop;
export const hostname = noop;
export const cpus = () => [];
export const freemem = () => 0;
export const totalmem = () => 0;
export const type = () => "Browser";
export const release = () => "";
export const networkInterfaces = () => ({});
export const EOL = "\n";
export const endianness = () => "LE";
export const userInfo = noop;

// events
export const EventEmitter = noopClass;
export const once = noop;

// util
export const inherits = noop;
export const promisify = noop;
export const types = noopObj;
export const inspect = noop;
export const deprecate = noop;
export const isDeepStrictEqual = noop;
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export const callbackify = noop;

// url
export { URL, URLSearchParams } from "./url-exports.js";
export const fileURLToPath = noop;
export const pathToFileURL = noop;

// buffer
export const Buffer = {
	from: () => new Uint8Array(),
	alloc: () => new Uint8Array(),
	allocUnsafe: () => new Uint8Array(),
	isBuffer: () => false,
	concat: () => new Uint8Array(),
	byteLength: () => 0,
};

// string_decoder
export const StringDecoder = noopClass;

// assert
export const ok = noop;
export const strictEqual = noop;
export const deepStrictEqual = noop;
export const notStrictEqual = noop;
export const AssertionError = noopClass;

// child_process
export const exec = noop;
export const execSync = noop;
export const execFile = noop;
export const spawn = noop;
export const fork = noop;

// worker_threads
export const Worker = noopClass;
export const isMainThread = true;
export const parentPort = null;
export const workerData = null;

// zlib
export const createGzip = noop;
export const createGunzip = noop;
export const createDeflate = noop;
export const createInflate = noop;
export const gzip = noop;
export const gunzip = noop;

// querystring
export const stringify = noop;
export const encode = noop;
export const decode = noop;

// http2
export const createSecureServer = noop;
export const sensitiveHeaders = Symbol("sensitiveHeaders");

// process
export const env = {};
export const cwd = () => "/";
export const argv = [];
export const pid = 0;
export const exit = noop;
export const nextTick = (fn: () => void) => Promise.resolve().then(fn);
export const stdout = noopObj;
export const stderr = noopObj;
export const stdin = noopObj;
export const versions = noopObj;
export const version = "";

// perf_hooks
export const performance = globalThis.performance;
export const PerformanceObserver = noopClass;

// async_hooks
export const AsyncLocalStorage = noopClass;
export const AsyncResource = noopClass;
export const createHook = noop;
export const executionAsyncId = noop;

// diagnostics_channel
export const channel = noop;
export const hasSubscribers = noop;
export const subscribe = noop;
export const unsubscribe = noop;
export const Channel = noopClass;

// vm
export const createContext = noop;
export const runInContext = noop;
export const runInNewContext = noop;
export const Script = noopClass;

// console
export const Console = noopClass;

// sqlite (node:sqlite)
export const DatabaseSync = noopClass;

// timers
export const setTimeout = globalThis.setTimeout;
export const setInterval = globalThis.setInterval;
export const setImmediate = noop;
export const clearTimeout = globalThis.clearTimeout;
export const clearInterval = globalThis.clearInterval;
export const clearImmediate = noop;

export default noopObj;
