using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Avalonia.Controls;

namespace CapriDesktop
{
    // Her words on screen and out loud in French, when her language is French. The text stays English in the code, and
    // this swaps it where it's shown: her bubble and voice, her menus, Mainframe and its tips. The dictionaries live in
    // cross/lang/fr/*.json, built into her. A line that isn't in them stays English, and in English nothing changes.
    //
    // Each file is { "lines": { "English": "Français" }, "tips": { "Tip name": "Texte" } }. A line with {0}, {1}... is a
    // template for text built around a name or number: "Can't reach {0}." matches "Can't reach http://x." and keeps the
    // filled-in part as it is.
    internal static class French
    {
        private static readonly Dictionary<string, string> exact = new Dictionary<string, string>(StringComparer.Ordinal);
        private static readonly List<KeyValuePair<Regex, string>> templates = new List<KeyValuePair<Regex, string>>();
        private static readonly Dictionary<string, string> tips = new Dictionary<string, string>(StringComparer.Ordinal);
        private static readonly Dictionary<string, string> seen = new Dictionary<string, string>(StringComparer.Ordinal);
        private static readonly ConditionalWeakTable<MenuItem, string[]> menuEnglish = new ConditionalWeakTable<MenuItem, string[]>();
        private static readonly Regex Sentences = new Regex(@"(?<=[.!?…])\s+(?=\S)", RegexOptions.Compiled);
        private static bool loaded;

        // Forced on or off by tests; otherwise it follows her language.
        internal static bool? Forced;
        internal static bool On { get { return Forced ?? Brain.LanguageCode(Brain.Language) == "fr"; } }

        internal static int Count { get { Load(); return exact.Count + templates.Count; } }

        // The French for a line, or the line itself when there's none or her language isn't French.
        internal static string T(string text)
        {
            if (string.IsNullOrEmpty(text) || !On) return text;
            Load();
            lock (seen)
            {
                string known;
                if (seen.TryGetValue(text, out known)) return known;
            }
            string french = Whole(text) ?? BySentence(text) ?? text;
            lock (seen)
            {
                if (seen.Count > 4000) seen.Clear();
                seen[text] = french;
            }
            return french;
        }

        // A Mainframe tip in French, already in its short form, or null to keep the English one.
        internal static string Tip(string name)
        {
            if (!On || name == null) return null;
            Load();
            string text;
            return tips.TryGetValue(name, out text) ? text : null;
        }

        // Her menus keep their English headers in code; each time one opens, every item shows in her language.
        internal static void Menu(ItemsControl menu)
        {
            if (menu == null) return;
            foreach (object child in menu.Items)
            {
                MenuItem item = child as MenuItem;
                if (item == null) continue;
                string header = item.Header as string;
                if (header != null)
                {
                    // Each item remembers its English and what it last showed. A header that is neither was set by the code
                    // since, so that's the new English.
                    string[] known;
                    if (!menuEnglish.TryGetValue(item, out known) || (header != known[0] && header != known[1])) known = new[] { header, header };
                    known[1] = T(known[0]);
                    menuEnglish.AddOrUpdate(item, known);
                    if (!string.Equals(header, known[1], StringComparison.Ordinal)) item.Header = known[1];
                }
                if (item.ItemCount > 0) Menu(item);
            }
        }

        private static string Whole(string text)
        {
            string french;
            if (exact.TryGetValue(text, out french)) return french;
            string trimmed = text.Trim();
            if (trimmed.Length != text.Length && exact.TryGetValue(trimmed, out french)) return text.Replace(trimmed, french);
            foreach (KeyValuePair<Regex, string> template in templates)
            {
                Match match = template.Key.Match(text);
                if (!match.Success) continue;
                return Regex.Replace(template.Value, @"\{(\d)\}", delegate(Match slot)
                {
                    Group filled = match.Groups["p" + slot.Groups[1].Value];
                    return filled.Success ? T(filled.Value) : slot.Value;
                });
            }
            return null;
        }

        // A reply made of several known sentences, like an answer with a hint added on the end.
        private static string BySentence(string text)
        {
            string[] parts = Sentences.Split(text);
            if (parts.Length < 2) return null;
            bool any = false;
            for (int i = 0; i < parts.Length; i++)
            {
                string french = Whole(parts[i]);
                if (french != null) { parts[i] = french; any = true; }
            }
            return any ? string.Join(" ", parts) : null;
        }

        private static void Load()
        {
            if (loaded) return;
            lock (exact)
            {
                if (loaded) return;
                System.Reflection.Assembly own = typeof(French).Assembly;
                List<string> names = new List<string>(own.GetManifestResourceNames());
                names.Sort(StringComparer.Ordinal);
                foreach (string name in names)
                {
                    if (!name.StartsWith("Capri.Lang.fr.", StringComparison.Ordinal)) continue;
                    try
                    {
                        using (Stream stream = own.GetManifestResourceStream(name))
                        using (JsonDocument document = JsonDocument.Parse(stream, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip }))
                        {
                            JsonElement section;
                            if (document.RootElement.TryGetProperty("lines", out section))
                                foreach (JsonProperty line in section.EnumerateObject()) Add(line.Name, line.Value.GetString());
                            if (document.RootElement.TryGetProperty("tips", out section))
                                foreach (JsonProperty tip in section.EnumerateObject()) tips[tip.Name] = tip.Value.GetString();
                        }
                    }
                    catch (Exception error) { Brain.Log("french", -1, name + ": " + error.Message); }
                }
                // Longer templates first, so the most specific one wins.
                templates.Sort((a, b) => b.Key.ToString().Length.CompareTo(a.Key.ToString().Length));
                loaded = true;
            }
        }

        private static void Add(string english, string french)
        {
            if (string.IsNullOrEmpty(english) || string.IsNullOrEmpty(french)) return;
            if (!Regex.IsMatch(english, @"\{\d\}")) { exact[english] = french; return; }
            StringBuilder pattern = new StringBuilder("^");
            int at = 0;
            HashSet<string> used = new HashSet<string>();
            foreach (Match slot in Regex.Matches(english, @"\{(\d)\}"))
            {
                pattern.Append(Regex.Escape(english.Substring(at, slot.Index - at)));
                string group = "p" + slot.Groups[1].Value;
                pattern.Append(used.Add(group) ? "(?<" + group + ">.+?)" : "\\k<" + group + ">");
                at = slot.Index + slot.Length;
            }
            pattern.Append(Regex.Escape(english.Substring(at))).Append('$');
            templates.Add(new KeyValuePair<Regex, string>(new Regex(pattern.ToString(), RegexOptions.Singleline | RegexOptions.CultureInvariant), french));
        }
    }
}
