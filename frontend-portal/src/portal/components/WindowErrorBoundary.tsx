// Isola falhas de uma janela: se o conteúdo crashar, só esta janela mostra o
// erro — o portal e as demais janelas seguem funcionando. (Sem isto, um erro de
// runtime numa janela derruba toda a árvore React.)

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  title: string
}
interface State {
  error: Error | null
}

export class WindowErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[portal] erro na janela "${this.props.title}":`, error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle className="text-destructive" size={28} />
          <p className="text-sm font-medium">Esta janela encontrou um erro</p>
          <p className="max-w-xs text-xs text-muted-foreground break-words">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Tentar novamente
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
