import type { MenuItem } from '@/portal/types'

export function applyMenuTranslationKeys(items: MenuItem[]): MenuItem[] {
  return items.map((item) => ({
    ...item,
    labelKey: item.labelKey ?? item.id,
    spec: item.spec
      ? {
          ...item.spec,
          titleKey: item.spec.titleKey ?? item.id,
        }
      : undefined,
    children: item.children ? applyMenuTranslationKeys(item.children) : undefined,
  }))
}
