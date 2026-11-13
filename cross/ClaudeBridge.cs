using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;

namespace CapriDesktop
{
    // Her Claude Code brain: the bridge in claude-bridge/ that answers like an OpenAI server with `claude -p`, on their
    // Claude plan. She starts it when her brain server is the bridge and stops it when she quits or picks another brain,
    // so they never have to run it themselves. A bridge already running (in a terminal or at login) is used as it is
    // and left alone. The bridge keeps nothing: her memories stay in her own files, so stopping it loses nothing.
    internal static class ClaudeBridge
    {
        internal const int Port = 4747;
        internal const string Address = "http://localhost:4747";
        internal const string Name = "Claude Code (your Claude plan)";
        private const string Banner = "Capri Claude Code bridge";

        internal static string LogPath;
        private static readonly object starting = new object();
        private static readonly object gate = new object();
        private static Process owned;
        private static bool stopped;

        internal static string Script { get { return Path.Combine(AppContext.BaseDirectory, "claude-bridge", "server.mjs"); } }
        internal static bool Bundled { get { return File.Exists(Script); } }

        // Her server is the bridge: this computer, on the bridge's port.
        internal static bool Is(string server)
        {
            Uri parsed;
            if (string.IsNullOrEmpty(server) || !Uri.TryCreate(server, UriKind.Absolute, out parsed) || parsed.Port != Port) return false;
            IPAddress host;
            return string.Equals(parsed.Host, "localhost", StringComparison.OrdinalIgnoreCase) || (IPAddress.TryParse(parsed.Host.Trim('[', ']'), out host) && IPAddress.IsLoopback(host));
        }

        // Starts the bridge when it isn't answering yet, and waits for it. Null when it's up, or what went wrong, in words
        // she can say. Safe from any thread, but it can wait a few seconds, so never call it on the UI thread.
        internal static string Ensure(int waitMs = 8000)
        {
            string problem = Starting(waitMs);
            if (problem != null) Brain.Log("claude-bridge", -1, problem);
            return problem;
        }

        private static string Starting(int waitMs)
        {
            lock (starting)
            {
                if (Healthy(800)) return null;
                if (stopped) return "Capri is closing.";
                Process running;
                lock (gate) running = owned != null && !owned.HasExited ? owned : null;
                if (running == null)
                {
                    if (!Bundled) return "The Claude Code bridge isn't in this copy of Capri.";
                    string node = Find("node", NodePlaces());
                    if (node == null) return "I need Node.js to use Claude Code. Install it from nodejs.org, then try again.";
                    string claude = Find("claude", ClaudePlaces());
                    if (claude == null) return "I can't find Claude Code. Install it, run claude once in a terminal to log in, then try again.";
                    string problem = Start(node, claude);
                    if (problem != null) return problem;
                }
                Stopwatch waited = Stopwatch.StartNew();
                while (waited.ElapsedMilliseconds < waitMs)
                {
                    if (Healthy(500)) return null;
                    lock (gate) if (owned == null || owned.HasExited) return "The Claude Code bridge stopped right after starting. Its log is " + (LogPath ?? "claude-bridge.log") + ".";
                    System.Threading.Thread.Sleep(150);
                }
                return "The Claude Code bridge didn't answer in time. Is port " + Port + " used by something else?";
            }
        }

        // Her own bridge stops with her. One she didn't start is left running.
        internal static void Stop()
        {
            Process process;
            lock (gate) { process = owned; owned = null; }
            if (process == null) return;
            try { if (!process.HasExited) { process.StandardInput.Close(); if (!process.WaitForExit(1500)) process.Kill(true); } }
            catch (Exception) { try { process.Kill(true); } catch (Exception) { } }
            finally { process.Dispose(); }
        }

        // Called when she quits: stops the bridge and keeps a late Ensure from starting another.
        internal static void Shutdown()
        {
            stopped = true;
            Stop();
        }

        // Her brain server changed: the bridge runs only while it's her brain.
        internal static void Follow(string server)
        {
            if (!Is(server)) System.Threading.ThreadPool.QueueUserWorkItem(delegate { Stop(); });
        }

        private static string Start(string node, string claude)
        {
            ProcessStartInfo start = new ProcessStartInfo(node)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(Script),
            };
            start.ArgumentList.Add(Script);
            // An app opened from Finder gets a bare PATH, so the bridge is told where node and claude are.
            string path = Environment.GetEnvironmentVariable("PATH") ?? "/usr/bin:/bin";
            start.Environment["PATH"] = Path.GetDirectoryName(claude) + ":" + Path.GetDirectoryName(node) + ":" + path;
            start.Environment["CLAUDE_BIN"] = claude;
            start.Environment["CAPRI_BRIDGE_PORT"] = Port.ToString();
            start.Environment["CAPRI_BRIDGE_WATCH_STDIN"] = "1";
            try
            {
                Process process = Process.Start(start);
                if (process == null) return "Couldn't start the Claude Code bridge.";
                TextWriter log = OpenLog();
                process.OutputDataReceived += (_, line) => Write(log, line.Data);
                process.ErrorDataReceived += (_, line) => Write(log, line.Data);
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                Write(log, "--- started by Capri at " + DateTime.Now.ToString("s") + " with " + node + " and " + claude);
                lock (gate) owned = process;
                return null;
            }
            catch (Exception error) { return "Couldn't start the Claude Code bridge: " + error.Message; }
        }

        private static TextWriter OpenLog()
        {
            if (LogPath == null) return null;
            try
            {
                // A log past a megabyte starts over, so it can't grow forever.
                if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 1024 * 1024) File.Delete(LogPath);
                return TextWriter.Synchronized(new StreamWriter(LogPath, true, new UTF8Encoding(false)) { AutoFlush = true });
            }
            catch (Exception) { return null; }
        }

        private static void Write(TextWriter log, string line)
        {
            if (log == null || line == null) return;
            try { log.WriteLine(line); } catch (Exception) { }
        }

        internal static bool Healthy(int timeoutMs)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Address + "/health");
                request.Timeout = timeoutMs;
                request.ReadWriteTimeout = timeoutMs;
                request.Proxy = null;
                using (WebResponse response = request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    return reader.ReadToEnd().Contains(Banner);
            }
            catch (Exception) { return false; }
        }

        private static IEnumerable<string> NodePlaces()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            yield return "/opt/homebrew/bin/node";
            yield return "/usr/local/bin/node";
            yield return Path.Combine(home, ".volta", "bin", "node");
            yield return Path.Combine(home, ".local", "share", "mise", "shims", "node");
            yield return Path.Combine(home, ".asdf", "shims", "node");
            string nvm = Path.Combine(home, ".nvm", "versions", "node");
            if (Directory.Exists(nvm))
            {
                string[] versions = Directory.GetDirectories(nvm);
                Array.Sort(versions, (a, b) => VersionOf(b).CompareTo(VersionOf(a)));
                foreach (string version in versions) yield return Path.Combine(version, "bin", "node");
            }
            yield return "/usr/bin/node";
        }

        private static Version VersionOf(string folder)
        {
            Version version;
            return Version.TryParse(Path.GetFileName(folder).TrimStart('v'), out version) ? version : new Version(0, 0);
        }

        private static IEnumerable<string> ClaudePlaces()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            yield return Path.Combine(home, ".local", "bin", "claude");
            yield return Path.Combine(home, ".claude", "local", "claude");
            yield return "/opt/homebrew/bin/claude";
            yield return "/usr/local/bin/claude";
            yield return Path.Combine(home, ".npm-global", "bin", "claude");
            yield return "/usr/bin/claude";
        }

        // The usual install places first, then her own PATH, then their login shell's, which knows about nvm and friends.
        private static string Find(string name, IEnumerable<string> places)
        {
            foreach (string place in places) if (Runnable(place)) return place;
            foreach (string folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':'))
                if (folder.Length > 0 && Runnable(Path.Combine(folder, name))) return Path.Combine(folder, name);
            return FromShell(name);
        }

        private static bool Runnable(string path)
        {
            try { return File.Exists(path) && (File.GetUnixFileMode(path) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0; }
            catch (Exception) { return false; }
        }

        private static string FromShell(string name)
        {
            string shell = Environment.GetEnvironmentVariable("SHELL");
            if (string.IsNullOrEmpty(shell) || !File.Exists(shell)) shell = OperatingSystem.IsMacOS() ? "/bin/zsh" : "/bin/bash";
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(shell) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
                start.ArgumentList.Add("-lic");
                start.ArgumentList.Add("command -v " + name);
                using (Process process = Process.Start(start))
                {
                    if (process == null) return null;
                    process.StandardInput.Close();
                    System.Threading.Tasks.Task<string> output = process.StandardOutput.ReadToEndAsync();
                    process.ErrorDataReceived += delegate { };
                    process.BeginErrorReadLine();
                    if (!process.WaitForExit(5000)) { try { process.Kill(true); } catch (Exception) { } return null; }
                    foreach (string line in output.Result.Split('\n'))
                    {
                        string found = line.Trim();
                        if (found.StartsWith("/", StringComparison.Ordinal) && Runnable(found)) return found;
                    }
                }
            }
            catch (Exception) { }
            return null;
        }
    }
}
