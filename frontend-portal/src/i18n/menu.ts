import type { Bookmark, MenuItem, PortalWindow, WindowSpec } from '@/portal/types'

type Translate = (key: string) => string

export function translateMenuLabel(item: Pick<MenuItem, 'labelKey' | 'text'>, t: Translate) {
  return item.labelKey ? t(item.labelKey) : item.text
}

export function translateSpecTitle(spec: Pick<WindowSpec, 'titleKey' | 'title'>, t: Translate) {
  return spec.titleKey ? t(spec.titleKey) : spec.title
}

export function translateWindowTitle(win: Pick<PortalWindow, 'titleKey' | 'title'>, t: Translate) {
  return win.titleKey ? t(win.titleKey) : win.title
}

export function translateBookmarkTitle(bookmark: Pick<Bookmark, 'textKey' | 'text'>, t: Translate) {
  return bookmark.textKey ? t(bookmark.textKey) : bookmark.text
}

export function localizeMenuTree(menu: MenuItem[], t: Translate): MenuItem[] {
  return menu.map((item) => {
    const text = translateMenuLabel(item, t)
    return {
      ...item,
      text,
      spec: item.spec ? { ...item.spec, title: translateSpecTitle(item.spec, t) } : undefined,
      children: item.children ? localizeMenuTree(item.children, t) : undefined,
    }
  })
}
