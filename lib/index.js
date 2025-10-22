import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import { Pool } from "pg";

const SCHEMA_VERSION = 1;

/**
 * @typedef {import("undici/types/cache-interceptor.d.ts").default.CacheStore} CacheStore
 * @typedef {import("undici/types/cache-interceptor.d.ts").default.CacheKey} CacheKey
 * @typedef {import("undici/types/cache-interceptor.d.ts").default.GetResult & { body?: Buffer }} GetResult
 * @typedef {import("undici/types/cache-interceptor.d.ts").default.CacheValue & { body: null | Buffer | Array<Buffer> }} CacheValue
 * @typedef {import("undici/types/cache-interceptor.d.ts").default.CacheControlDirectives} CacheControlDirectives
 * @typedef {import("pg").QueryResult<PgCacheStoreRawValue>} QueryResult
 * @typedef {import("pg").PoolConfig} PoolConfig
 */

/**
 * @typedef {{
 *   id: Readonly<number>;
 *   body?: Buffer;
 *   statusCode: number;
 *   statusMessage: string;
 *   headers?: string;
 *   vary?: string;
 *   etag?: string;
 *   cacheControlDirectives?: string;
 *   cachedAt: number;
 *   staleAt: number;
 *   deleteAt: number;
 * }} PgCacheStoreValue
 *
 * @typedef {{
 *   id: Readonly<number>;
 *   body?: Buffer;
 *   status_code: number;
 *   status_message: string;
 *   headers?: string;
 *   vary?: string;
 *   etag?: string;
 *   cache_control_directives?: string;
 *   cached_at: number;
 *   stale_at: number;
 *   delete_at: number;
 * }} PgCacheStoreRawValue
 */

/**
 * @implements {CacheStore}
 */
export class PgCacheStore {
  /**
   * @type {import("pg").Pool}
   */
  #db;
  /**
   * @type {Promise<void>}
   */
  #ready;

  /**
   * @param {PoolConfig | undefined} options
   */
  constructor(options) {
    this.#db = new Pool(options);
    this.#ready = this.#init();
  }

  /**
   * @returns {Promise<void>}
   */
  async #init() {
    await this.#db.query(`CREATE TABLE IF NOT EXISTS cache_v${SCHEMA_VERSION} (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      method TEXT NOT NULL,
      body BYTEA,
      status_code INTEGER NOT NULL,
      status_message TEXT NOT NULL,
      headers TEXT NOT NULL,
      cache_control_directives TEXT NOT NULL,
      etag TEXT NOT NULL,
      vary JSONB NOT NULL,
      delete_at BIGINT NOT NULL,
      cached_at BIGINT NOT NULL,
      stale_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cache_v${SCHEMA_VERSION}_lookup ON cache_v${SCHEMA_VERSION}(url, method, delete_at);
    CREATE INDEX IF NOT EXISTS idx_cache_v${SCHEMA_VERSION}_delete ON cache_v${SCHEMA_VERSION}(delete_at);
    `);
  }

  /**
   * @param {CacheKey} key
   * @returns {string}
   */
  #makeValueUrl(key) {
    return `${key.origin}/${key.path}`;
  }

  /**
   * @param {number} id
   * @param {CacheValue} value
   */
  async #updateValue(id, value) {
    await this.#ready;
    await this.#db.query(`UPDATE cache_v${SCHEMA_VERSION} SET
      body = $1,
      delete_at = $2,
      status_code = $3,
      status_message = $4,
      headers = $5,
      etag = $6,
      cache_control_directives = $7,
      cached_at = $8,
      stale_at = $9
    WHERE
      id = $10`, [
      value.body,
      value.deleteAt,
      value.statusCode,
      value.statusMessage,
      JSON.stringify(value.headers),
      value.etag,
      JSON.stringify(value.cacheControlDirectives),
      value.cachedAt,
      value.staleAt,
      id,
    ]);
  }

  /**
   * @param {string} url
   * @param {string} method
   * @param {CacheValue} value
   */
  async #insertValue(url, method, value) {
    await this.#ready;
    await this.#db.query(`INSERT INTO cache_v${SCHEMA_VERSION} (
        url,
        method,
        body,
        delete_at,
        status_code,
        status_message,
        headers,
        etag,
        cache_control_directives,
        vary,
        cached_at,
        stale_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
      url,
      method,
      value.body,
      value.deleteAt,
      value.statusCode,
      value.statusMessage,
      JSON.stringify(value.headers ?? {}),
      value.etag ?? "",
      JSON.stringify(value.cacheControlDirectives ?? {}),
      JSON.stringify(value.vary ?? {}),
      value.cachedAt,
      value.staleAt,
    ]);
  }

  /**
   * @param {number} id
   */
  async #delete(id) {
    await this.#ready;
    await this.#db.query(`DELETE FROM cache_v${SCHEMA_VERSION} WHERE id = $1`, [id]);
  }

  async #prune() {
    await this.#ready;
    await this.#db.query(`DELETE FROM cache_v${SCHEMA_VERSION} WHERE delete_at <= $1`, [Date.now()]);
  }

  /**
   * @param {CacheKey} key
   * @param {boolean} [canBeExpired=false]
   * @returns {Promise<PgCacheStoreValue | undefined>}
   */
  async #findValue(key, canBeExpired = false) {
    await this.#ready;
    const url = this.#makeValueUrl(key);

    /** @type {QueryResult} */
    const result = await this.#db.query(`WITH matching_requests AS (
      SELECT
        *,
        (
          SELECT jsonb_object_agg(k, incoming->k)
          FROM jsonb_object_keys(vary) AS v(k),
               (SELECT $2::jsonb AS incoming) i
        ) AS normalized_headers
      FROM cache_v${SCHEMA_VERSION}
      WHERE url = $1
      ${canBeExpired === false ? "AND delete_at >= $3::bigint" : ""}
      ORDER BY delete_at ASC
    )
    SELECT * FROM matching_requests
    WHERE vary = normalized_headers`,
    [url, JSON.stringify(key.headers ?? {}), ...(canBeExpired ? [] : [Date.now()])]);

    if (result.rows.length === 0) {
      return undefined;
    }

    const {
      status_code,
      status_message,
      cache_control_directives,
      delete_at,
      cached_at,
      stale_at,
      ...rest
    } = result.rows[0];

    return {
      ...rest,
      statusCode: status_code,
      statusMessage: status_message,
      cacheControlDirectives: cache_control_directives,
      deleteAt: Number(delete_at),
      cachedAt: Number(cached_at),
      staleAt: Number(stale_at),
    };
  }

  close() {
    void this.#db.end();
  }

  /**
   * @param {CacheKey} key
   * @returns {Promise<GetResult | undefined>}
   */
  async get(key) {
    assertCacheKey(key);
    const value = await this.#findValue(key);
    return value
      ? {
          body: value.body,
          statusCode: value.statusCode,
          statusMessage: value.statusMessage,
          headers: /** @type {Record<string, string[] | string>} */ (
            value.headers ? /** @type {unknown} */ (JSON.parse(value.headers)) : {}
          ),
          etag: value.etag ? value.etag : undefined,
          vary: /** @type {Record<string, string[] | string | null > | undefined} */ (
            value.vary ?? undefined
          ),
          cacheControlDirectives: /** @type {CacheControlDirectives} */ (
            value.cacheControlDirectives ? /** @type {unknown} */ (JSON.parse(value.cacheControlDirectives)) : {}
          ),
          cachedAt: value.cachedAt,
          staleAt: value.staleAt,
          deleteAt: value.deleteAt,
        }
      : undefined;
  }

  /**
   * @param {CacheKey} key
   * @param {CacheValue} value
   */
  async set(key, value) {
    assertCacheKey(key);

    const url = this.#makeValueUrl(key);
    const body = Array.isArray(value.body) ? Buffer.concat(value.body) : value.body;

    const existingValue = await this.#findValue(key, true);
    if (existingValue) {
      await this.#updateValue(existingValue.id, { ...value, body });
    } else {
      await this.#prune();
      await this.#insertValue(url, key.method, { ...value, body });
    }
  }

  /**
   * @param {CacheKey} key
   * @param {CacheValue} value
   */
  createWriteStream(key, value) {
    assertCacheKey(key);
    assertCacheValue(value);

    /** @type {Buffer[]} */
    const body = [];

    return new Writable({
      decodeStrings: true,
      /**
       * @param {Buffer} chunk
       */
      write: (chunk, _encoding, callback) => {
        body.push(chunk);
        callback();
      },
      final: (callback) => {
        void this.set(key, { ...value, body })
          .catch(callback)
          .then(() => {
            callback();
          });
      },
    });
  }

  /**
   * @param {CacheKey} key
   */
  async delete(key) {
    assertCacheKey(key);

    const existingValue = await this.#findValue(key);
    if (existingValue) {
      await this.#delete(existingValue.id);
    }
  }
}

// while you _can_ deeply require these right out of undici, it causes all sorts of typescript
// complaints so i've copied them here for simplicity

/**
 * @param {unknown} key
 * @returns {asserts key is CacheKey}
 */
function assertCacheKey(key) {
  if (!key) {
    throw new TypeError(`expected key to have a value`);
  }

  if (typeof key !== "object") {
    throw new TypeError(`expected key to be object, got ${typeof key}`);
  }

  const obj = /** @type {Record<string, unknown>} */ (key);

  for (const property of ["origin", "method", "path"]) {
    if (!(property in obj)) {
      throw new TypeError(`expected key.${property} to exist`);
    }

    if (typeof obj[property] !== "string") {
      throw new TypeError(`expected key.${property} to be string, got ${typeof obj[property]}`);
    }
  }

  if (obj.headers !== undefined && typeof obj.headers !== "object") {
    throw new TypeError(`expected headers to be object, got ${typeof key}`);
  }
}

/**
 * @param {unknown} value
 * @returns {asserts value is CacheValue}
 */
function assertCacheValue(value) {
  if (!value) {
    throw new TypeError(`expected value to have a value`);
  }

  if (typeof value !== "object") {
    throw new TypeError(`expected value to be object, got ${typeof value}`);
  }

  const obj = /** @type {Record<string, unknown>} */ (value);

  for (const property of ["statusCode", "cachedAt", "staleAt", "deleteAt"]) {
    if (typeof obj[property] !== "number") {
      throw new TypeError(`expected value.${property} to be number, got ${typeof obj[property]}`);
    }
  }

  if (typeof obj.statusMessage !== "string") {
    throw new TypeError(`expected value.statusMessage to be string, got ${typeof obj.statusMessage}`);
  }

  if (obj.headers != null && typeof obj.headers !== "object") {
    throw new TypeError(`expected value.rawHeaders to be object, got ${typeof obj.headers}`);
  }

  if (obj.vary !== undefined && typeof obj.vary !== "object") {
    throw new TypeError(`expected value.vary to be object, got ${typeof obj.vary}`);
  }

  if (obj.etag !== undefined && typeof obj.etag !== "string") {
    throw new TypeError(`expected value.etag to be string, got ${typeof obj.etag}`);
  }
}
