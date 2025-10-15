# RawView State Management Fix

## Problem Statement

The `rawView` state management needed refinement to properly handle the distinction between:
- **Global state when maximized** - All maximized entities share the same rawView toggle
- **Individual state when collapsed** - Each entity maintains its own rawView preference

### Previous Incorrect Behavior

When a user:
1. Maximized entity A and toggled to raw view
2. Switched to entity B (which became maximized with raw view - correct)
3. Collapsed entity B back
4. ❌ Entity B's collapsed state was now "raw view" (incorrect - it should return to its original state)

The issue was that the global `rawView` preference was being **persisted to the node model**, overwriting each entity's individual preference.

## Solution Architecture

### Key Principle: Dual State Management

We now maintain **two separate states** for `rawView`:

1. **Global State** (in `diagramRegistry`)
   - `globalRawViewPreference: boolean`
   - Shared across all maximized entities
   - Applied when `isMaximized = true`

2. **Individual State** (in each `SchemaNodeModel`)
   - `model.rawView: boolean`
   - Unique to each entity
   - Applied when `isMaximized = false`

### Computed Property: `effectiveRawView`

At render time, we compute the effective rawView to display:

```typescript
const effectiveRawView = canonicalModel?.isMaximized 
  ? globalViewState.globalRawViewPreference  // Use global when maximized
  : canonicalModel?.rawView ?? false         // Use individual when collapsed
```

## Implementation Details

### Change 1: Remove Global State Persistence to Model

**File**: `SchemaDiagram.tsx`  
**Function**: `getOrCreateDiagram()`

**Before**:
```typescript
if (rootNode) {
  rootNode.isMaximized = viewState.hasAnyMaximizedEntity
  rootNode.rawView = viewState.globalRawViewPreference  // ❌ This overwrites individual state!
}
```

**After**:
```typescript
if (rootNode) {
  rootNode.isMaximized = viewState.hasAnyMaximizedEntity
  // rawView is NOT set here - it's computed at render time based on maximized state
}
```

**Rationale**: We no longer overwrite the node model's individual `rawView` with the global preference.

### Change 2: Compute Effective RawView at Render Time

**File**: `SchemaDiagram.tsx`  
**Function**: `enrichNodesWithHandlers()`

**Added**:
```typescript
const globalViewState = diagramRegistry.getViewState()

return nodes.map((node) => {
  const canonicalModel = diagram.getNodeModel(node.id)
  
  // Compute effective rawView based on maximization state
  const effectiveRawView = canonicalModel?.isMaximized 
    ? globalViewState.globalRawViewPreference  // Global when maximized
    : canonicalModel?.rawView ?? false         // Individual when collapsed

  return {
    ...node,
    data: {
      ...node.data,
      model: canonicalModel,
      effectiveRawView, // Pass computed value to view
      // ... other props
    },
  }
})
```

**Rationale**: The view receives the correct `rawView` value based on current state, without modifying the model.

### Change 3: Update Toggle Logic

**File**: `SchemaNodeView.tsx`  
**Method**: `handleToggleRawView()`

**Before**:
```typescript
private handleToggleRawView = () => {
  const next = !this.model.rawView
  this.model.rawView = next          // Always updates model
  this.onNodeChange?.()
  if (this.model.isMaximized) {
    this.onMaximizeRawJson?.(next)   // Also updates global
  }
  this.forceUpdate()
}
```

**After**:
```typescript
private handleToggleRawView = () => {
  const d = this.props.data || {}
  const currentRawView = d.effectiveRawView ?? this.model.rawView
  const next = !currentRawView
  
  if (this.model.isMaximized) {
    // When maximized, ONLY update global state (don't touch model)
    this.onMaximizeRawJson?.(next)
  } else {
    // When collapsed, ONLY update model's individual preference
    this.model.rawView = next
    this.onNodeChange?.()
  }
  this.forceUpdate()
}
```

**Rationale**: 
- When **maximized**: Toggle only affects global state
- When **collapsed**: Toggle only affects individual model state
- No cross-contamination between the two states

### Change 4: Use Effective RawView for Display

**File**: `SchemaNodeView.tsx`  
**Method**: `render()`

**Before**:
```typescript
const rawView = this.model ? !!this.model.rawView : false  // Always from model
```

**After**:
```typescript
// Use effectiveRawView from props (computed upstream), fall back to model
const rawView = d.effectiveRawView ?? (this.model ? !!this.model.rawView : false)
```

**Rationale**: Display the computed effective value, not directly from the model.

## State Flow Diagrams

### Scenario 1: Toggle While Maximized

```
User clicks rawView toggle (node is maximized)
    ↓
handleToggleRawView() detects isMaximized = true
    ↓
Calls onMaximizeRawJson(next)
    ↓
Updates diagramRegistry.globalRawViewPreference
    ↓
Component re-renders with new effectiveRawView
    ↓
All maximized nodes reflect the new global state
    ↓
Individual model.rawView remains unchanged ✓
```

### Scenario 2: Toggle While Collapsed

```
User clicks rawView toggle (node is collapsed)
    ↓
handleToggleRawView() detects isMaximized = false
    ↓
Updates model.rawView directly
    ↓
Calls onNodeChange() to mark dirty
    ↓
Component re-renders with new model.rawView
    ↓
Only this node's collapsed state changes ✓
    ↓
Global state remains unchanged ✓
```

### Scenario 3: Expand → Toggle → Collapse

```
1. Entity A is collapsed with rawView = false
    ↓
2. User maximizes Entity A
    effectiveRawView = globalRawViewPreference (e.g., false)
    ↓
3. User toggles to raw view
    globalRawViewPreference = true
    effectiveRawView = true
    model.rawView still = false (unchanged) ✓
    ↓
4. User collapses Entity A
    effectiveRawView = model.rawView (false)
    Returns to original state ✓
```

## Testing Checklist

### Manual Tests

- [x] TypeScript compilation passes
- [ ] **Test 1**: Maximize entity A → toggle rawView → entity A shows raw JSON
- [ ] **Test 2**: With entity A maximized in raw view → select entity B → entity B is maximized in raw view (global state shared)
- [ ] **Test 3**: With entity A maximized in raw view → collapse entity A → entity A returns to formatted view (original state preserved)
- [ ] **Test 4**: Entity A collapsed → toggle rawView → only entity A's collapsed state changes (not global)
- [ ] **Test 5**: Save layout with mixed states → reload → states restored correctly
- [ ] **Test 6**: Multiple entities with different individual rawView preferences → maximize each → all show same rawView (global) → collapse each → each returns to its own preference

### Edge Cases

- [ ] Switch entities rapidly while maximized → all show consistent global state
- [ ] Toggle rawView while switching entities → no state corruption
- [ ] Save/load with entity maximized → rawView states preserved correctly

## Files Modified

1. **`/Users/alexa/git/github/gts/apps/web/src/components/SchemaDiagram.tsx`**
   - `getOrCreateDiagram()`: Removed global rawView persistence to model
   - `enrichNodesWithHandlers()`: Added effectiveRawView computation

2. **`/Users/alexa/git/github/gts/apps/web/src/components/SchemaNodeView.tsx`**
   - `handleToggleRawView()`: Conditional update logic based on maximized state
   - `render()`: Use effectiveRawView for display
   - Maximized overlay: Use computed rawView variable

## Key Benefits

1. **✅ State Separation**: Global and individual states are truly independent
2. **✅ Intuitive Behavior**: Entities "remember" their collapsed state even when maximized with different settings
3. **✅ No State Pollution**: Global state doesn't contaminate individual preferences
4. **✅ Predictable**: Clear rules about when each state is used
5. **✅ Maintainable**: Logic is centralized and well-documented

## Technical Debt Addressed

- Removed dual responsibility from `model.rawView` (was serving both global and individual roles)
- Clarified ownership: global state in registry, individual state in model, effective state computed at render
- Improved separation of concerns between state management and display logic

---

**Implemented by**: AI Assistant  
**Date**: 2025-10-08  
**Related to**: Global state management refactoring  
**Issue**: RawView state contamination between global and individual preferences  
**Solution**: Dual state management with computed effective value
