// ========================================================================
// 0. NODE_ENV NORMALIZATION
// ========================================================================
// System env (e.g. Docker) may set NODE_ENV=production while the actual context
// is development. We detect the real mode from signals that can't be faked:
//   - TEST_TYPE → test mode
//   - npm_lifecycle_event → dev/build/migrate commands
//   - .env.production missing but .env.development exists → likely dev

import fs from 'fs'
import dotenv from 'dotenv'
import { expand } from 'dotenv-expand'
import path from 'path'
import { defineConfig, Modules } from '@medusajs/framework/utils'
import { isIzipayProviderConfigured, resolveIzipayConfig } from './src/utils/izipay-config'

const envDir = process.cwd()

if (
  process.env.TEST_TYPE === 'integration:http' ||
  process.env.TEST_TYPE === 'integration:modules' ||
  process.env.TEST_TYPE === 'unit'
) {
  process.env.NODE_ENV = 'test'
} else if (process.env.NODE_ENV === 'production') {
  const lifecycle = process.env.npm_lifecycle_event || ''
  const isDevCommand = ['dev', 'develop', 'db:generate', 'db:migrate', 'db:setup', 'db:create', 'db:rollback', 'db:run-scripts', 'db:sync-links'].includes(lifecycle)
  const envProdExists = fs.existsSync(path.join(envDir, '.env.production'))
  const envDevExists = fs.existsSync(path.join(envDir, '.env.development'))
  if (isDevCommand || (!envProdExists && envDevExists)) {
    process.env.NODE_ENV = 'development'
  }
}

const NODE_ENV = process.env.NODE_ENV || 'development'

// ========================================================================
// 1. ENVIRONMENT FILE LOADING
// ========================================================================
// Two-pass loading:
//   1. Environment-specific file (.env.development / .env.production / .env.test)
//      with override=true — the env file IS the source of truth for that environment.
//   2. Base .env as fallback with override=false — fills missing values only.
const envSpecificFile = path.join(envDir, `.env.${NODE_ENV}`)
const envBaseFile = path.join(envDir, '.env')

try { expand(dotenv.config({ path: envSpecificFile, override: true })) } catch { /* optional */ }
try { expand(dotenv.config({ path: envBaseFile, override: false })) } catch { /* optional */ }

// ========================================================================
// 2. MIDDLEWARE: SKIP PUBLISHABLE KEY FOR KEYCLOAK AUTH ENDPOINTS
// ========================================================================
// Keycloak auth POST requests don't carry a publishable API key.
// Monkey-patch Medusa's middleware to skip those paths.

type MinimalRequest = { method?: string; originalUrl?: string; baseUrl?: string; path?: string }
type NextFn = (error?: unknown) => void
type MiddlewareFn = (req: MinimalRequest, res: unknown, next: NextFn) => Promise<void> | void

function isKeycloakAuthRequest(req: MinimalRequest): boolean {
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''
  if (method !== 'POST' && method !== 'OPTIONS') return false

  const originalUrl = req.originalUrl || ''
  const combinedPath = `${req.baseUrl || ''}${req.path || ''}`

  return (
    originalUrl.startsWith('/store/auth/keycloak') ||
    combinedPath === '/store/auth/keycloak' ||
    req.path === '/auth/keycloak'
  )
}

const ensurePublishableModule = require(require.resolve(
  path.join(path.dirname(require.resolve('@medusajs/framework')), 'http', 'middlewares', 'ensure-publishable-api-key.js')
)) as { ensurePublishableApiKeyMiddleware: MiddlewareFn }

const originalMiddleware = ensurePublishableModule.ensurePublishableApiKeyMiddleware
ensurePublishableModule.ensurePublishableApiKeyMiddleware = async (req, res, next) => {
  if (isKeycloakAuthRequest(req)) return next()
  return originalMiddleware(req, res, next)
}

// ========================================================================
// 3. MODE DETECTION FLAGS
// ========================================================================
const IS_BUILD = process.env.IS_BUILD === 'true' || process.env.npm_lifecycle_event === 'build'
const IS_TEST = NODE_ENV === 'test'
const IS_MIGRATION = process.env.IS_MIGRATION === 'true'
const DISABLE_REDIS = IS_BUILD || IS_TEST || IS_MIGRATION

// ========================================================================
// 4. ENVIRONMENT VARIABLES
// ========================================================================
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL
const DEPLOYMENT_TYPE = process.env.DEPLOYMENT_TYPE || 'local'
const RABBITMQ_URL = process.env.RABBITMQ_URL

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9000'
const STORE_CORS = process.env.STORE_CORS || BACKEND_URL
const ADMIN_CORS = process.env.ADMIN_CORS || BACKEND_URL
const AUTH_CORS = process.env.AUTH_CORS || BACKEND_URL
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret'
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'supersecret'

if (!DISABLE_REDIS && !RABBITMQ_URL) {
  throw new Error('RABBITMQ_URL is required when RabbitMQ integrations are enabled')
}

const CACHE_REDIS_URL = process.env.CACHE_REDIS_URL
const WE_REDIS_URL = process.env.WE_REDIS_URL
const LOCKING_REDIS_URL = process.env.LOCKING_REDIS_URL

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT
const MINIO_ACCESS_KEY_ID = process.env.MINIO_ACCESS_KEY_ID
const MINIO_SECRET_ACCESS_KEY = process.env.MINIO_SECRET_ACCESS_KEY
const MINIO_REGION = process.env.MINIO_REGION
const MINIO_BUCKET = process.env.MINIO_BUCKET
const MINIO_FILE_URL = process.env.MINIO_FILE_URL

const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY
const S3_REGION = process.env.S3_REGION
const S3_BUCKET = process.env.S3_BUCKET
const S3_FILE_URL = process.env.S3_FILE_URL

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL

const STRIPE_API_KEY = process.env.STRIPE_API_KEY
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

const IZIPAY_CONFIG = resolveIzipayConfig(NODE_ENV)
const IZIPAY_IS_CONFIGURED = isIzipayProviderConfigured(NODE_ENV)

const KEYCLOAK_URL = process.env.KEYCLOAK_URL
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID
const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET
const KEYCLOAK_CALLBACK_URL = process.env.KEYCLOAK_CALLBACK_URL || `${BACKEND_URL}/app/login`
const KEYCLOAK_STORE_CLIENT_ID = process.env.KEYCLOAK_STORE_CLIENT_ID
const KEYCLOAK_STORE_CLIENT_SECRET = process.env.KEYCLOAK_STORE_CLIENT_SECRET

// ========================================================================
// 5. CONFIGURATION EXPORT
// ========================================================================
module.exports = defineConfig({
  projectConfig: {
    databaseUrl: DATABASE_URL,
    ...(DEPLOYMENT_TYPE === 'local'
      ? { databaseDriverOptions: { connection: { ssl: false } } }
      : { databaseDriverOptions: { connection: { ssl: { rejectUnauthorized: false } } } }),
    redisUrl: DISABLE_REDIS ? undefined : REDIS_URL,
    workerMode: (process.env.MEDUSA_WORKER_MODE as 'server' | 'worker' | 'shared' | undefined) || 'shared',
    http: {
      storeCors: STORE_CORS,
      adminCors: ADMIN_CORS,
      authCors: AUTH_CORS,
      jwtSecret: JWT_SECRET,
      cookieSecret: COOKIE_SECRET,
      ...(KEYCLOAK_URL && KEYCLOAK_CLIENT_ID ? {
        authMethodsPerActor: {
          user: ['emailpass', 'keycloak-admin'],
          customer: ['emailpass', 'keycloak-store'],
        },
      } : {}),
    },
  },
  admin: {
    backendUrl: BACKEND_URL,
    disable: process.env.DISABLE_MEDUSA_ADMIN === 'true',
  },
  modules: [
    {
      key: Modules.CACHING,
      resolve: '@medusajs/caching',
      options: {
        in_memory: {
          enable: DISABLE_REDIS || !CACHE_REDIS_URL,
        },
        providers: !DISABLE_REDIS && CACHE_REDIS_URL
          ? [{
              resolve: '@medusajs/caching-redis',
              id: 'redis',
              is_default: true,
              options: { redisUrl: CACHE_REDIS_URL },
            }]
          : [],
      },
    },
    {
      key: Modules.EVENT_BUS,
      resolve: DISABLE_REDIS
        ? '@medusajs/medusa/event-bus-local'
        : './src/modules/event-bus-rabbitmq',
      options: {
        ...(DISABLE_REDIS ? {} : { rabbitmqUrl: requireEnv('RABBITMQ_URL'), queuePrefix: 'medusa', prefetch: 100, maxRetries: 3, retryDelayMs: 30000 }),
      },
    },
    {
      resolve: './src/modules/events',
      options: {
        rabbitmqUrl: DISABLE_REDIS ? '' : requireEnv('RABBITMQ_URL'),
        exchanges: {
          integration: 'tourism.integration',
          notification: 'tourism.notification',
          inbound: 'tourism.inbound',
          identity: 'identity.events',
        },
        consumers: [
          { name: 'product', routingKeys: ['integration.product.#'], prefetch: 10, maxRetries: 3, retryDelayMs: 30000 },
          { name: 'booking', routingKeys: ['integration.booking.#'], prefetch: 5, maxRetries: 3, retryDelayMs: 30000 },
          { name: 'order', routingKeys: ['integration.order.#'], prefetch: 10, maxRetries: 3, retryDelayMs: 30000 },
          { name: 'tour', routingKeys: ['integration.tour.#'], prefetch: 5, maxRetries: 3, retryDelayMs: 30000 },
          { name: 'package', routingKeys: ['integration.package.#'], prefetch: 5, maxRetries: 3, retryDelayMs: 30000 },
          { name: 'email', routingKeys: ['notification.#'], prefetch: 20, maxRetries: 3, retryDelayMs: 60000 },
          { name: 'inbound', routingKeys: ['inbound.#'], prefetch: 10, maxRetries: 3, retryDelayMs: 15000 },
          { name: 'identity', routingKeys: ['identity.user.#'], prefetch: 5, maxRetries: 3, retryDelayMs: 30000 },
        ],
        workerMode: process.env.MEDUSA_WORKER_MODE || 'shared',
      },
    },
    {
      key: Modules.WORKFLOW_ENGINE,
      resolve: DISABLE_REDIS
        ? '@medusajs/medusa/workflow-engine-inmemory'
        : WE_REDIS_URL
          ? '@medusajs/medusa/workflow-engine-redis'
          : '@medusajs/medusa/workflow-engine-inmemory',
      options: { redis: { url: WE_REDIS_URL } },
    },
    ...(LOCKING_REDIS_URL && !DISABLE_REDIS ? [{
      key: Modules.LOCKING,
      resolve: '@medusajs/medusa/locking',
      options: {
        providers: [{
          resolve: '@medusajs/medusa/locking-redis',
          id: 'locking-redis',
          is_default: true,
          options: { redisUrl: LOCKING_REDIS_URL },
        }],
      },
    }] : []),
    {
      resolve: '@medusajs/medusa/file',
      options: {
        providers: [
          ...(MINIO_ENDPOINT && MINIO_ACCESS_KEY_ID && MINIO_SECRET_ACCESS_KEY ? [{
            resolve: '@medusajs/medusa/file-s3',
            id: 'minio',
            options: {
              file_url: MINIO_FILE_URL,
              access_key_id: MINIO_ACCESS_KEY_ID,
              secret_access_key: MINIO_SECRET_ACCESS_KEY,
              region: MINIO_REGION,
              bucket: MINIO_BUCKET,
              endpoint: MINIO_ENDPOINT,
              additional_client_config: { forcePathStyle: true },
            },
          }] : []),
          ...(S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY ? [{
            resolve: '@medusajs/medusa/file-s3',
            id: 's3',
            options: {
              file_url: S3_FILE_URL,
              access_key_id: S3_ACCESS_KEY_ID,
              secret_access_key: S3_SECRET_ACCESS_KEY,
              region: S3_REGION,
              bucket: S3_BUCKET,
              endpoint: S3_ENDPOINT,
              additional_client_config: { forcePathStyle: true },
            },
          }] : []),
          ...(!MINIO_ENDPOINT && !S3_ENDPOINT ? [{
            resolve: '@medusajs/file-local',
            id: 'local',
            options: {
              upload_dir: 'static',
              backend_url: `${BACKEND_URL}/static`,
            },
          }] : []),
        ],
      },
    },
    ...(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL ? [{
      key: Modules.NOTIFICATION,
      resolve: '@medusajs/notification',
      options: {
        providers: [{
          resolve: '@medusajs/notification-sendgrid',
          id: 'sendgrid',
          options: { channels: ['email'], api_key: SENDGRID_API_KEY, from: SENDGRID_FROM_EMAIL },
        }],
      },
    }] : []),
    ...((STRIPE_API_KEY && STRIPE_WEBHOOK_SECRET) || IZIPAY_IS_CONFIGURED ? [{
      key: Modules.PAYMENT,
      resolve: '@medusajs/payment',
      options: {
        providers: [
          ...(STRIPE_API_KEY && STRIPE_WEBHOOK_SECRET ? [{
            resolve: '@medusajs/payment-stripe',
            id: 'stripe',
            options: { apiKey: STRIPE_API_KEY, webhookSecret: STRIPE_WEBHOOK_SECRET },
          }] : []),
          ...(IZIPAY_IS_CONFIGURED ? [{
            resolve: './src/modules/izipay-payment',
            id: 'izipay',
            options: {
              merchantCode: IZIPAY_CONFIG.merchantCode!,
              publicKey: IZIPAY_CONFIG.publicKey!,
              hashKey: IZIPAY_CONFIG.hashKey!,
              apiEndpoint: IZIPAY_CONFIG.apiEndpoint!,
              sdkUrl: IZIPAY_CONFIG.sdkUrl!,
            },
          }] : []),
        ],
      },
    }] : []),
    { resolve: './src/modules/tour' },
    { resolve: './src/modules/package' },
    { resolve: './src/modules/booking-form' },
    { resolve: './src/modules/order-notification' },
    { resolve: './src/modules/izipay' },
    {
      resolve: '@medusajs/medusa/auth',
      options: {
        providers: [
          { resolve: '@medusajs/medusa/auth-emailpass', id: 'emailpass' },
          ...(KEYCLOAK_URL && KEYCLOAK_CLIENT_ID ? [{
            resolve: './src/modules/keycloak-auth',
            id: 'keycloak-admin',
            options: {
              keycloakUrl: KEYCLOAK_URL,
              realm: KEYCLOAK_REALM,
              clientId: KEYCLOAK_CLIENT_ID,
              clientSecret: KEYCLOAK_CLIENT_SECRET,
              callbackUrl: `${BACKEND_URL}/auth/user/keycloak-admin/callback`,
              scope: 'openid profile email',
            },
          }] : []),
          ...(KEYCLOAK_URL && KEYCLOAK_STORE_CLIENT_ID ? [{
            resolve: './src/modules/keycloak-auth-store',
            id: 'keycloak-store',
            options: {
              keycloakUrl: KEYCLOAK_URL,
              realm: KEYCLOAK_REALM,
              clientId: KEYCLOAK_STORE_CLIENT_ID,
              clientSecret: KEYCLOAK_STORE_CLIENT_SECRET,
              callbackUrl: `${BACKEND_URL}/auth/customer/keycloak-store/callback`,
              scope: 'openid profile email',
            },
          }] : []),
        ],
      },
    },
  ],
  plugins: [],
})
