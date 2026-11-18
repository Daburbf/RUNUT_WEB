<script setup>
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from './components/AppHeader.vue'
import AppFooter from './components/AppFooter.vue'
import { job } from './store/analysis'

const route = useRoute()
const router = useRouter()

watch(
  () => job.status,
  (status, prev) => {
    if (status === 'done' && prev === 'running' && job.documentId) {
      const target = `/hasil/${job.documentId}`
      if (route.path !== target) {
        router.push(target)
      }
    }
  },
)
</script>

<template>
  <div class="flex min-h-screen flex-col overflow-x-hidden">
    <AppHeader />
    <main class="flex-1">
      <router-view />
    </main>
    <AppFooter />
  </div>
</template>
