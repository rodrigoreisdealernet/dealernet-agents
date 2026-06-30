import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'

// Serve o BUILD estático do DHI Front (DealernetHubIntegration/dist) sob /dhi/, na
// MESMA origem do portal. Usado na demo por túnel (1 URL só): as telas de cadastro
// abrem sem cookie cross-site. Gere o build com: cd DealernetHubIntegration &&
// VITE_BASE=/dhi/ npm run build. Sem dist, o middleware fica inerte (dev normal).
function serveDhiFront(distDir: string): Plugin {
  const mime: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
  }
  return {
    name: 'serve-dhi-front',
    configureServer(server) {
      server.middlewares.use('/dhi', (req, res, next) => {
        if (!fs.existsSync(distDir)) return next()
        const urlPath = (req.url || '/').split('?')[0]
        let file = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, ''))
        // SPA fallback: rota sem extensão → index.html
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          file = path.join(distDir, 'index.html')
        }
        try {
          const ext = path.extname(file)
          res.setHeader('Content-Type', mime[ext] || 'application/octet-stream')
          res.end(fs.readFileSync(file))
        } catch {
          next()
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const dhiDist = path.resolve(__dirname, '../DealernetHubIntegration/dist')
  // Node 17+ resolve `localhost` p/ ::1 (IPv6) ANTES de 127.0.0.1. O http-proxy
  // tenta o primeiro endereço e recebe ECONNREFUSED (AggregateError) → o proxy
  // devolve 500 de corpo vazio e o front mostra "Não foi possível conectar".
  // Forçar 127.0.0.1 evita a rota IPv6 e estabiliza o proxy de dev.
  const target = (env.VITE_API_TARGET || 'http://localhost:8080').replace(
    /\/\/localhost(?=[:/])/,
    '//127.0.0.1',
  )

  // ops-api (FastAPI /api/ops) — alvo do proxy configurável. Default :8000, mas
  // permite outra porta (ex.: :8009) quando :8000 está ocupada por outro stack.
  const opsTarget = (env.VITE_OPS_API_TARGET || 'http://127.0.0.1:8000').replace(
    /\/\/localhost(?=[:/])/,
    '//127.0.0.1',
  )

  // Demo via túnel (ngrok, HTTPS cross-site): cookie de sessão no iframe exige
  // SameSite=None; Secure. Em dev local (http), usa Lax. Ligar com VITE_TUNNEL=1.
  const tunnel = env.VITE_TUNNEL === '1'
  const fixCookie = (c: string) =>
    tunnel
      ? c.replace(/;\s*SameSite=(Lax|Strict)/gi, '; SameSite=None').replace(/(;\s*SameSite=None)(?!.*Secure)/gi, '$1; Secure')
      : c.replace(/;\s*Secure/gi, '').replace(/;\s*SameSite=None/gi, '; SameSite=Lax')

  return {
    plugins: [react(), tailwindcss(), serveDhiFront(dhiDist)],
    // Algumas libs (ex.: react-rnd) referenciam `process.env.NODE_ENV` no browser.
    // O Vite não define `process` por padrão -> ReferenceError. Definimos aqui.
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
      'process.env': '{}',
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5174,
      // Bind em todas as interfaces para que tanto :5174 (host) quanto o
      // portal-bridge (docker → host.docker.internal:5174 → :5273) alcancem o dev.
      host: true,
      open: true,
      // Libera hosts de túnel (ngrok) p/ demo. Sem isto o Vite 6 bloqueia: "host not allowed".
      allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io'],
      proxy: {
        // ops-api FastAPI (IA proativa / Operations Factory) na :8000.
        // As rotas do FastAPI JÁ incluem o prefixo /api/ops (ex.: /api/ops/findings/decision),
        // então encaminhamos SEM rewrite — igual ao proxy do dia-frontend. (POC: approve/reject)
        '/api/ops': {
          target: opsTarget,
          changeOrigin: true,
          secure: false,
        },
        // SHELL ÚNICO: cada front/backend do DMS sob a origem do portal (:5174).
        // /produto/ → front React DealernetProduto (porta interna 5176), com HMR (ws).
        // SEM rewrite: o front roda com base '/produto/' (VITE_BASE), então serve e pede
        // os assets já sob esse path. Reescrever quebraria a resolução dos assets/HMR.
        '/produto': {
          target: 'http://127.0.0.1:5176',
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        // Backend GeneXus do Produto na :8082, virtual dir /DealernetProduto/.
        '/DealernetProduto': {
          target: 'http://127.0.0.1:8082',
          changeOrigin: true,
          secure: false,
          cookieDomainRewrite: '',
          cookiePathRewrite: '/',
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              const sc = proxyRes.headers['set-cookie']
              if (sc) proxyRes.headers['set-cookie'] = sc.map(fixCookie)
            })
          },
        },
        // Encaminha as chamadas ao backend GeneXus mantendo a mesma origem para o
        // navegador, de modo que o cookie de sessão (Set-Cookie HttpOnly) seja
        // aceito e reenviado automaticamente. Reescreve o cookie p/ a origem local.
        // O prefixo é o nome da app GeneXus (.NET Core), onde vivem as APIs REST.
        // DHI agora na :8083, virtual dir /DealernetHubIntegration/ (via VITE_API_TARGET).
        '/DealernetHubIntegration': {
          target,
          changeOrigin: true,
          secure: false,
          cookieDomainRewrite: '',
          cookiePathRewrite: '/',
          configure: (proxy) => {
            proxy.on('error', (err, _req, res) => {
              // Sem este handler, um erro de conexão vira 500 de corpo vazio.
              // Logamos a causa real e devolvemos algo legível ao front.
              console.error('[proxy] erro ao falar com o backend:', err.message)
              if (res && 'writeHead' in res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ erro: 'backend_indisponivel', detalhe: err.message }))
              }
            })
            proxy.on('proxyRes', (proxyRes) => {
              const sc = proxyRes.headers['set-cookie']
              if (sc) {
                proxyRes.headers['set-cookie'] = sc.map(fixCookie)
              }
            })
          },
        },
        // POC EV2 mesma-origem: o WF legado (IIS na :80) servido SOB a origem do
        // portal, para o cookie de sessão do WF (ASP.NET_SessionId/GX_SESSION_ID)
        // valer dentro do iframe. Em produção isto vira um reverse proxy real.
        '/DealerNetWF': {
          target: 'http://127.0.0.1:80',
          changeOrigin: true,
          secure: false,
          cookieDomainRewrite: '',
          cookiePathRewrite: '/DealerNetWF',
          configure: (proxy) => {
            proxy.on('error', (err, _req, res) => {
              console.error('[proxy WF] erro ao falar com o WF:', err.message)
              if (res && 'writeHead' in res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('WF indisponível: ' + err.message)
              }
            })
            proxy.on('proxyRes', (proxyRes) => {
              const sc = proxyRes.headers['set-cookie']
              if (sc) {
                proxyRes.headers['set-cookie'] = sc.map(fixCookie)
              }
            })
          },
        },
      },
    },
  }
})
