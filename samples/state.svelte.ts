export function createCounter() {
  let value = $state(0);

  function getValue() {
    return value;
  }

  function increment() {
    value += 1;
  }

  function label() {
    return `Count is ${getValue()}`;
  }

  return {
    getValue,
    increment,
    label
  };
}
