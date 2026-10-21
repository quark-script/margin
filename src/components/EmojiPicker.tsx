import { useMemo, useState } from "react";

// A small curated set keeps the bundle light and the choice quick.
const GROUPS: { name: string; emoji: string }[] = [
  { name: "Common", emoji: "📝 📄 📌 📎 ✅ ☑️ 📅 🗓️ ⏰ 💡 ⭐ 🔥 🎯 🚀 📚 📖 🧠 💼 🏠 ❤️" },
  { name: "Work", emoji: "💻 🖥️ ⌨️ 🧪 🔬 🛠️ ⚙️ 🧩 📊 📈 📉 🗂️ 📁 🗃️ 🧾 ✉️ 📬 🔒 🔑 🐛" },
  { name: "Life", emoji: "🏃 🏋️ 🧘 🥗 🍳 ☕ 🍵 💤 🛒 💰 💳 🏦 ✈️ 🗺️ 🏔️ 🌱 🌿 🌸 🎵 🎮" },
  { name: "People", emoji: "🙂 😊 😎 🤔 🙏 👋 👍 💪 👨‍👩‍👧 👥 🧑‍💻 🧑‍🎓 🎓 🎉 🎁 🏆 ♟️ 🧊 📷 🎨" },
  { name: "Symbols", emoji: "🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔶 🔷 ❗ ❓" },
];

const ALL = GROUPS.flatMap((g) => g.emoji.split(" "));

export function EmojiPicker({ onPick, onRemove }: { onPick: (e: string) => void; onRemove?: () => void }) {
  const [custom, setCustom] = useState("");
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, list: g.emoji.split(" ") })), []);

  return (
    <div className="w-[300px] p-2">
      <div className="mb-2 flex items-center gap-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) onPick([...custom.trim()][0] ?? custom.trim());
          }}
          placeholder="Type or paste any emoji"
          className="h-8 min-w-0 flex-1 rounded-md bg-hover px-2 text-[13px] outline-none placeholder:text-faint"
        />
        {onRemove && (
          <button onClick={onRemove} className="h-8 rounded-md px-2 text-[13px] text-muted hover:bg-hover">
            Remove
          </button>
        )}
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {groups.map((g) => (
          <div key={g.name} className="mb-1.5">
            <div className="px-1 pb-0.5 text-[11px] font-medium text-muted">{g.name}</div>
            <div className="grid grid-cols-10">
              {g.list.map((e) => (
                <button
                  key={e}
                  onClick={() => onPick(e)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[17px] hover:bg-hover"
                  aria-label={`Use ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function randomEmoji() {
  return ALL[Math.floor(Math.random() * 20)];
}
