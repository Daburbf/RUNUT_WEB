import { createRouter, createWebHashHistory } from 'vue-router'
import { auth } from '../store/auth'
import { session } from '../utils/api'

const routes = [
  { path: '/', name: 'landing', component: () => import('../views/LandingView.vue') },
  { path: '/tentang', name: 'about', component: () => import('../views/AboutView.vue') },
  { path: '/masuk', name: 'login', component: () => import('../views/LoginView.vue'), meta: { guest: true } },
  { path: '/daftar', name: 'register', component: () => import('../views/RegisterView.vue'), meta: { guest: true } },
  { path: '/lupa-sandi', name: 'forgot', component: () => import('../views/ForgotPasswordView.vue'), meta: { guest: true } },
  { path: '/atur-ulang', name: 'reset', component: () => import('../views/ResetPasswordView.vue'), meta: { guest: true } },
  { path: '/analisis', name: 'analyze', component: () => import('../views/AnalyzeView.vue'), meta: { auth: true } },
  { path: '/hasil/:id?', name: 'result', component: () => import('../views/ResultView.vue'), meta: { auth: true } },
  { path: '/bandingkan/:id?', name: 'compare', component: () => import('../views/CompareView.vue'), meta: { auth: true } },
  { path: '/dokumen/:id', name: 'document-detail', component: () => import('../views/DocumentDetailView.vue'), meta: { auth: true } },
  { path: '/riwayat', name: 'history', component: () => import('../views/HistoryView.vue'), meta: { auth: true } },
  {
    path: '/token',
    alias: ['/beli-token', '/isi-token', '/premium'],
    name: 'tokens',
    component: () => import('../views/PremiumView.vue'),
    meta: { auth: true },
  },
  { path: '/akun', name: 'account', component: () => import('../views/AccountView.vue'), meta: { auth: true } },
  { path: '/:pathMatch(.*)*', name: 'notfound', component: () => import('../views/NotFoundView.vue') },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) {
      return { el: to.hash, behavior: 'smooth', top: 100 }
    }
    // Jangan memaksa scroll ke atas bila hanya query yang berubah pada rute yang sama.
    if (to.path === from.path) return false
    return { top: 0 }
  },
})

router.beforeEach(async (to) => {
  if (!auth.ready || (auth.user && !session.access)) {
    try { await auth.init() } catch { /* abaikan */ }
  }
  if (to.meta.auth && !auth.user) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.meta.guest && auth.user) return { name: 'analyze' }
})

export default router
