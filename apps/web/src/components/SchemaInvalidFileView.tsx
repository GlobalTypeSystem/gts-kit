import { Component } from 'react'
import { X, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SchemaInvalidFileModel } from './SchemaInvalidFileModel'

interface SchemaInvalidFileViewProps {
  model: SchemaInvalidFileModel
  onClose: () => void
}

export class SchemaInvalidFileView extends Component<SchemaInvalidFileViewProps> {
  private renderCodeWithErrors(code: string): JSX.Element {
    const validation = this.props.model.file.validation
    if (!validation || validation.errors.length === 0) {
      return <pre className="m-0 p-3 text-xs leading-5 font-mono text-gray-200 select-text cursor-text">{code}</pre>
    }

    // Extract error positions from validation errors
    // JSONC parser errors contain offset information in the message
    const errorRegions: Array<{ start: number; end: number; message: string }> = []

    validation.errors.forEach((error) => {
      // Try to extract offset from error message like "at offset 123 (length: 5)"
      const match = error.message.match(/at offset (\d+) \(length: (\d+)\)/)
      if (match) {
        const offset = parseInt(match[1], 10)
        const length = parseInt(match[2], 10)
        errorRegions.push({
          start: offset,
          end: offset + length,
          message: error.message
        })
      }
    })

    // If no offset information, just show plain text
    if (errorRegions.length === 0) {
      return <pre className="m-0 p-3 text-xs leading-5 font-mono text-gray-200 select-text cursor-text">{code}</pre>
    }

    // Split code into segments with and without errors
    const segments: Array<{ text: string; isError: boolean; message?: string }> = []
    let lastIndex = 0

    errorRegions.sort((a, b) => a.start - b.start).forEach((region) => {
      // Add normal text before error
      if (region.start > lastIndex) {
        segments.push({ text: code.substring(lastIndex, region.start), isError: false })
      }
      // Add error text
      segments.push({
        text: code.substring(region.start, region.end),
        isError: true,
        message: region.message
      })
      lastIndex = region.end
    })

    // Add remaining text
    if (lastIndex < code.length) {
      segments.push({ text: code.substring(lastIndex), isError: false })
    }

    return (
      <pre className="m-0 p-3 text-xs leading-5 font-mono text-gray-200 select-text cursor-text">
        {segments.map((segment, index) =>
          segment.isError ? (
            <span
              key={index}
              className="bg-red-500 text-white px-1 rounded cursor-help"
              title={segment.message}
            >
              {segment.text}
            </span>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </pre>
    )
  }

  render() {
    const { model, onClose } = this.props
    const validation = model.file.validation

    return (
      <div className="w-full h-full bg-card rounded-lg shadow-2xl flex flex-col overflow-hidden">
        <div className={cn('p-4 border-b rounded-t-lg border-red-200 bg-red-100')}>
          <div className={cn('flex items-center justify-between text-base text-red-600')}>
            <div className="flex items-center space-x-2 overflow-hidden font-semibold">
              <AlertCircle className="h-5 w-5" />
              <span className="truncate leading-[1.0]">{model.file.name}</span>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-full hover:bg-black/10"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 p-4 overflow-auto text-sm">
          {validation && validation.errors.length > 0 && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded select-text cursor-text">
              <div className="text-sm font-medium text-red-800 mb-2">Invalid JSON File:</div>
              <div className="space-y-1">
                {validation.errors.map((error: any, index: number) => (
                  <div key={index} className="text-sm text-red-700 select-text cursor-text">
                    {error.message}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="rounded border bg-[#011627] overflow-auto select-text cursor-text">
            {this.renderCodeWithErrors(typeof model.file.content === 'string' ? model.file.content : JSON.stringify(model.file.content, null, 2))}
          </div>
        </div>
      </div>
    )
  }
}
