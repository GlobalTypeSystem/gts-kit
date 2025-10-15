import * as React from "react"

import { cn } from "@/lib/utils"

const MenuPanel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "h-full border bg-gray-50 text-foreground",
      className
    )}
    {...props}
  />
))
MenuPanel.displayName = "MenuPanel"

const MenuHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "p-4 border-b sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
      className
    )}
    {...props}
  />
))
MenuHeader.displayName = "MenuHeader"

const MenuTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "text-sm font-semibold tracking-wide uppercase text-muted-foreground",
      className
    )}
    {...props}
  />
))
MenuTitle.displayName = "MenuTitle"

const MenuContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-0", className)} {...props} />
))
MenuContent.displayName = "MenuContent"

export { MenuPanel, MenuHeader, MenuTitle, MenuContent }

// Menu item building blocks
interface MenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
  selected?: boolean
  disabled?: boolean
  entityType?: 'json' | 'schema' | 'invalid_file'
}

const MenuItem = React.forwardRef<HTMLDivElement, MenuItemProps>(
  ({ className, selected = false, disabled = false, entityType, ...props }, ref) => {
    // Get entity-specific colors matching SchemaNodeView header colors
    const getEntityColors = () => {
      if (!entityType) return ""

      if (entityType === 'schema') {
        // Schema entities: blue colors
        return selected
          ? "bg-blue-100 border-blue-200 text-blue-600"
          : "hover:bg-gray-300 hover:border-gray-200 hover:text-gray-700"
      } else if (entityType === 'invalid_file') {
        // Invalid JSON file entities: red colors
        return selected
          ? "bg-red-100 border-red-200 text-red-600"
          : "hover:bg-gray-300 hover:border-gray-200 hover:text-gray-700"
      } else {
        // JSON object entities: green colors
        return selected
          ? "bg-green-200 border-green-300 text-green-700"
          : "hover:bg-gray-300 hover:border-gray-200 hover:text-gray-700"
      }
    }

    const entityColors = getEntityColors()

    return (
      <div
        ref={ref}
        aria-disabled={disabled}
        className={cn(
          "flex items-center space-x-3 p-2 rounded-md transition-colors border border-transparent",
          disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer",
          "w-[98%] max-w-[98%] overflow-hidden",
          // Apply entity-specific colors if entityType is provided, otherwise use default gray
          entityType ? entityColors : (
            disabled ? "" : "hover:bg-gray-200 hover:text-accent-foreground"
          ),
          // Default selected state for non-entity items
          !entityType && selected && "bg-gray-200 text-accent-foreground",
          className
        )}
        {...props}
      />
    )
  }
)
MenuItem.displayName = "MenuItem"

interface MenuItemContentProps extends React.HTMLAttributes<HTMLDivElement> {
  html?: string
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim()
}

const MenuItemContent = React.forwardRef<HTMLDivElement, MenuItemContentProps>(
  ({ className, html, children, ...props }, ref) => {
    const tooltip = props.title ?? (typeof html === 'string' ? stripTags(html) : undefined)

    // The outer div with min-w-0 and max-w-full is crucial for flexbox truncation.
    // It allows this container to shrink, forcing the inner div (with truncate) to ellipsis.
    const containerClasses = cn("flex-1 min-w-0 max-w-full overflow-hidden", className);

    if (html) {
      return (
        <div ref={ref} className={containerClasses} {...props}>
          <div
            title={tooltip}
            className="text-xs font-medium leading-tight truncate w-full"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )
    }

    return (
      <div ref={ref} className={containerClasses} {...props}>
        <div title={tooltip} className="text-xs font-medium leading-tight truncate w-full">
          {children}
        </div>
      </div>
    )
  }
)
MenuItemContent.displayName = "MenuItemContent"

export { MenuItem, MenuItemContent }
