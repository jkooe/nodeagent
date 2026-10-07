/** 设备列表 store：本地保存的被控端配置（名称 / 地址 / PSK），CRUD + 持久化。 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

export interface NodeProfile {
  id: string;
  name: string;
  url: string;
  key: string;
}

export const useNodeStore = defineStore("node", () => {
  const nodes = ref<NodeProfile[]>(JSON.parse(localStorage.getItem("na.nodes") || "[]"));
  const currentId = ref<string | null>(localStorage.getItem("na.current"));

  const current = computed(() => nodes.value.find((n) => n.id === currentId.value) ?? null);

  function persist() {
    localStorage.setItem("na.nodes", JSON.stringify(nodes.value));
    localStorage.setItem("na.current", currentId.value ?? "");
  }

  function add(profile: Omit<NodeProfile, "id">): NodeProfile {
    const node: NodeProfile = { id: crypto.randomUUID(), ...profile };
    nodes.value.push(node);
    persist();
    return node;
  }

  function update(id: string, patch: Partial<NodeProfile>) {
    const idx = nodes.value.findIndex((n) => n.id === id);
    if (idx >= 0) {
      nodes.value[idx] = { ...nodes.value[idx], ...patch };
      persist();
    }
  }

  function remove(id: string) {
    nodes.value = nodes.value.filter((n) => n.id !== id);
    if (currentId.value === id) currentId.value = null;
    persist();
  }

  function setCurrent(id: string | null) {
    currentId.value = id;
    persist();
  }

  return { nodes, currentId, current, add, update, remove, setCurrent };
});
