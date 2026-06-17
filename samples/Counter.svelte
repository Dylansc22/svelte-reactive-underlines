<script lang="ts">
  let count = $state(0);
  let doubled = $derived(count * 2);

  function getValue() {
    return count;
  }

  function formatValue() {
    return `value: ${getValue()}`;
  }

  function plainFunction() {
    return 'not reactive';
  }
</script>

<button onclick={() => count += 1}>
  {getValue()} / {doubled}
</button>

<p>{plainFunction()}</p>
