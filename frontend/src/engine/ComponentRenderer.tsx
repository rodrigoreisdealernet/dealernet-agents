/**
 * ComponentRenderer
 *
 * Recursively renders component trees from JSON definitions
 * Handles conditionals (if), loops (each), and expression evaluation
 */

import { useMemo } from 'react';
import { getGlobalRegistry } from '@/registry/createRegistry';
import {
  evaluateExpression,
  resolveProps,
  mergeContext,
} from './ExpressionEvaluator';
import type { ComponentDefinition, ExpressionContext } from './types';

interface ComponentRendererProps {
  /** Component definition to render */
  definition: ComponentDefinition;
  /** Expression context */
  context: ExpressionContext;
}

/**
 * ComponentRenderer - Renders a single component and its children
 */
export function ComponentRenderer({
  definition,
  context,
}: ComponentRendererProps) {
  const registry = getGlobalRegistry();

  // Hooks must be called unconditionally before any early returns
  const resolvedProps = useMemo(() => {
    return definition.props ? resolveProps(definition.props, context) : {};
  }, [definition.props, context]);

  const renderedChildren = useMemo(() => {
    if (!definition.children || definition.children.length === 0) {
      return null;
    }
    return definition.children.map((child, index) => (
      <ComponentRenderer key={index} definition={child} context={context} />
    ));
  }, [definition.children, context]);

  const slots = useMemo(() => {
    if (!definition.slots) return undefined;
    const renderedSlots: Record<string, React.ReactNode> = {};
    for (const [slotName, slotContent] of Object.entries(definition.slots)) {
      if (Array.isArray(slotContent)) {
        renderedSlots[slotName] = slotContent.map((child, index) => (
          <ComponentRenderer key={index} definition={child} context={context} />
        ));
      } else {
        renderedSlots[slotName] = (
          <ComponentRenderer definition={slotContent} context={context} />
        );
      }
    }
    return renderedSlots;
  }, [definition.slots, context]);

  // Handle conditional rendering.
  // Skip when `each` is also present: the `if` will be re-evaluated per-item
  // after the loop variable is added to context, so evaluating it here against
  // the outer context (where the loop variable is undefined) would always return
  // a wrong result.
  if (definition.if !== undefined && definition.each === undefined) {
    const condition = evaluateExpression(definition.if, context);
    if (!condition) {
      return null;
    }
  }

  // Handle list rendering (each)
  if (definition.each !== undefined) {
    const items = evaluateExpression(definition.each, context);

    if (!Array.isArray(items)) {
      console.warn(`"each" expression did not return an array:`, definition.each);
      return null;
    }

    const itemKey = definition.as || 'item';
    const indexKey = definition.indexAs || 'index';

    return (
      <>
        {items.map((item, index) => {
          const itemContext = mergeContext(context, {
            [itemKey]: item,
            [indexKey]: index,
            row: typeof item === 'object' ? item as Record<string, unknown> : undefined,
            item,
            index,
          } as Partial<ExpressionContext>);

          const key = definition.key
            ? String(evaluateExpression(definition.key, itemContext))
            : String(index);

          const itemDefinition: ComponentDefinition = {
            ...definition,
            each: undefined,
            as: undefined,
            indexAs: undefined,
            key: undefined,
          };

          return (
            <ComponentRenderer
              key={key}
              definition={itemDefinition}
              context={itemContext}
            />
          );
        })}
      </>
    );
  }

  // Get the component from registry
  const Component = registry.get(definition.type);

  if (!Component) {
    console.warn(`Component not found in registry: ${definition.type}`);
    return (
      <div className="p-4 border border-red-300 bg-red-50 text-red-700 rounded">
        Unknown component: {definition.type}
      </div>
    );
  }

  // Render the component
  // Only pass explicit children if we have rendered child components
  // This allows props.children (from expressions) to be used when no child components are defined
  if (renderedChildren) {
    return (
      <Component {...resolvedProps} slots={slots}>
        {renderedChildren}
      </Component>
    );
  }

  return <Component {...resolvedProps} slots={slots} />;
}

/**
 * Render multiple component definitions
 */
export function renderComponents(
  definitions: ComponentDefinition[] | undefined,
  context: ExpressionContext
): React.ReactNode {
  if (!definitions || definitions.length === 0) {
    return null;
  }

  return definitions.map((def, index) => (
    <ComponentRenderer key={index} definition={def} context={context} />
  ));
}
