import { useId, useState } from 'react'

// Keep confirmation in the app. Desktop dialog plugins can replace
// window.confirm with an asynchronous API whose Promise is always truthy.
export function ConfirmRemove({ label, message, disabled, onConfirm }: {
  label: string
  message: string
  disabled: boolean
  onConfirm: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const description = useId()
  if (!confirming) return <button type="button" disabled={disabled} onClick={() => setConfirming(true)}>{label}</button>
  return <div className="automation-remove-confirm" role="group" aria-labelledby={description}>
    <p id={description}>{message}</p>
    <button type="button" disabled={disabled} autoFocus onClick={() => setConfirming(false)}>取消</button>
    <button type="button" disabled={disabled} onClick={() => { setConfirming(false); onConfirm() }}>确认移除</button>
  </div>
}
