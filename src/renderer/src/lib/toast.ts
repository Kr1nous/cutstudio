import { useEffect, useState } from 'react'

export type ToastKind = 'info' | 'ok' | 'error'
export type ToastItem = { id: number; text: string; kind: ToastKind; details?: string[] }

let seq = 0
let items: ToastItem[] = []
const subs = new Set<(list: ToastItem[]) => void>()

function publish(): void {
  for (const fn of subs) fn(items)
}

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id)
  publish()
}

/** 右上角提示：3.5 秒自动消失（出错 6 秒，有细节时再多留一会）。 */
export function toast(text: string, kind: ToastKind = 'info', details?: string[]): void {
  const id = ++seq
  items = [...items.slice(-3), { id, text, kind, details: details?.length ? details : undefined }]
  publish()
  const ms = (kind === 'error' ? 6000 : 3500) + (details?.length ? 2500 : 0)
  window.setTimeout(() => dismissToast(id), ms)
}

export function toastError(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e), 'error')
}

export function useToasts(): ToastItem[] {
  const [list, setList] = useState(items)
  useEffect(() => {
    subs.add(setList)
    return () => {
      subs.delete(setList)
    }
  }, [])
  return list
}
