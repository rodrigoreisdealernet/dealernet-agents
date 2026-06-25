function toTitleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

export function getEntityLabels(entityType: string) {
  if (!entityType) {
    return {
      singular: 'Entity',
      plural: 'Entities',
      singularLower: 'entity',
      pluralLower: 'entities',
    };
  }

  const words = entityType
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  if (words.length === 0) {
    return {
      singular: 'Entity',
      plural: 'Entities',
      singularLower: 'entity',
      pluralLower: 'entities',
    };
  }

  const singularWords = [...words];
  const pluralWords = [...words];
  pluralWords[pluralWords.length - 1] = pluralize(pluralWords[pluralWords.length - 1]);

  const singular = singularWords.map(toTitleCase).join(' ');
  const plural = pluralWords.map(toTitleCase).join(' ');

  return {
    singular,
    plural,
    singularLower: singular.toLowerCase(),
    pluralLower: plural.toLowerCase(),
  };
}
