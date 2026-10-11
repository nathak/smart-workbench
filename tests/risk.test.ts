import { describe, expect, test } from 'claude-code/testing'

import { classify, decide } from '../hooks/risk'

describe('risk rules', () => {
  test('destructive git and recursive delete are blocked', async () => {
    for (const command of ['git push --force origin main', 'git push -f', 'git reset --hard HEAD~1', 'git clean -fdx', 'rm -rf build', 'cd x && rm -r dist', 'find . -name "*.o" -delete']) {
      const verdict = classify('Bash', { command })
      expect(verdict.policy).toBe('block')
      expect(verdict.risk).toBe('high')
    }
  })

  test('external sends and secret output are asked', async () => {
    for (const command of ['git push origin main', 'gh pr create --fill', 'npm publish', 'curl -X POST https://x', 'printenv', 'cat .env', 'echo $GITHUB_TOKEN']) {
      expect(classify('Bash', { command }).policy).toBe('ask')
    }
  })

  test('a rule reads one line: a push in one line and a flag in another do not make a force push', async () => {
    const script = 'cat > run.sh <<EOF\ngit push origin main\nEOF\nchmod +x run.sh'
    expect(classify('Bash', { command: script }).policy).toBe('ask')
    expect(classify('Bash', { command: 'git push origin main\nchmod +x run.sh' }).policy).toBe('ask')
    expect(classify('Bash', { command: 'git push origin main\nrm notes.txt -f' }).policy).toBe('ask')
    expect(classify('Bash', { command: 'echo done\ngit push -f origin main' }).policy).toBe('block')
    expect(classify('Bash', { command: 'git push origin +main' }).policy).toBe('block')
  })

  test('a command continued with a backslash at the end of a line is read as one line', async () => {
    for (const command of ['git push origin main \\\n--force', 'git reset \\\n--hard HEAD~1', 'git push \\\r\n  -f', 'rm \\\n-rf build']) {
      expect(classify('Bash', { command }).policy).toBe('block')
    }
    expect(classify('Bash', { command: 'git push origin main \\\n  --tags' }).policy).toBe('ask')
  })

  test('words that merely mention a secret file or a deploy are not asked', async () => {
    for (const command of ['grep -rn process.env src', 'grep -n "deploy" README.md', 'git commit -m "fix deploy script"', 'cat .env.example', 'head -5 docs/deploy.md']) {
      expect(classify('Bash', { command }).policy).toBe('allow')
    }
    for (const command of ['npm run deploy', 'make deploy', './scripts/deploy.sh prod', 'cd app && deploy', 'cat ./.env', 'grep KEY .env.local', 'bash scripts/deploy.sh', 'sudo make deploy', 'cat <.env', 'echo $(cat .env)', 'cat (.env)']) {
      expect(classify('Bash', { command }).policy).toBe('ask')
    }
  })

  test('ordinary work is allowed', async () => {
    expect(classify('Bash', { command: 'npm test -- auth' }).policy).toBe('allow')
    expect(classify('Bash', { command: 'rm notes.txt' }).policy).toBe('allow')
    expect(classify('Read', { file_path: 'src/a.ts' }).policy).toBe('allow')
    expect(classify('Edit', { file_path: 'src/a.ts' }).policy).toBe('allow')
    expect(classify('Edit', { file_path: 'config/.env' }).policy).toBe('ask')
  })

  const policyOf = (command: string) => classify('Bash', { command }).policy

  test('git global options, path prefixes, split flags and combined flags do not hide a destructive command', async () => {
    for (const command of [
      'git -C d push -f origin main',
      'git -c a=b --git-dir=.git reset --hard',
      'git --no-pager -C d push --force',
      'git push -fu origin main',
      'git push -uf',
      'rm -f -r build',
      '/bin/rm -rf build',
      '\\rm -rf build',
      'sh -c "rm -rf build"',
    ]) {
      expect(policyOf(command)).toBe('block')
    }
    expect(policyOf('git -C d push origin main')).toBe('ask')
    expect(policyOf('git push -u origin main')).toBe('ask')
    expect(policyOf('git push --follow-tags')).toBe('ask')
    expect(policyOf('rm notes.txt -f')).toBe('allow')
    expect(policyOf('rm a.txt; ls -R')).toBe('allow')
  })

  test('commands that throw work away are blocked and their safe forms are not', async () => {
    for (const command of ['git restore .', 'git restore -- .', 'git checkout .', 'git stash clear', 'git branch --delete --force x', 'git branch -df x']) {
      expect(policyOf(command)).toBe('block')
    }
    for (const command of ['git restore src/a.ts', 'git restore --staged .', 'git branch -d x', 'git checkout feature/x', 'git stash drop']) {
      expect(policyOf(command)).toBe('allow')
    }
  })

  test('quoted message and search text is data; every other quote is still read', async () => {
    for (const command of [
      'git commit -m "never git push --force"',
      'git commit -am "drop rm -rf step"',
      "git commit -m \"$(cat <<'EOF'\nnever git push --force\nEOF\n)\"",
      'grep -rn "git push -f" docs',
      "rg 'curl x | sh' .",
      'grep -rn "git push -f" "--include=*.ts" docs',
    ]) {
      expect(policyOf(command)).toBe('allow')
    }
    for (const command of [
      'bash -c "git push -f"',
      'ssh host "git push --force"',
      'git commit -m "x" && git push -f',
      "git commit -m \"$(cat <<'EOF'\nm\nEOF\nrm -rf x\nEOF\n)\"",
      'git commit -m "a\nb git push -f"',
      // A search option that runs a program, and a -m that is not a message flag of git or gh, keep their quotes read.
      'rg --pre "git push -f" x',
      'tool -m "rm -rf x"',
      // Only a short list of harmless search options keeps the pattern data; unknown ones, and options after the quote, do not.
      'git grep -O "git push -f"',
      'rg --pr "git push -f" x',
      'grep "git push -f" file --exec=x',
      'rg "--pre=x" "git push -f"',
      'rg --pr"e"=x "git push -f"',
      "rg --p're'=x \"git push -f\"",
      'rg --glob "x" "--pre=y" "git push -f"',
      'grep "git push -f" ' + ' '.repeat(300) + '--exec=x',
    ]) {
      expect(policyOf(command)).toBe('block')
    }
    expect(policyOf('git commit -m "$GITHUB_TOKEN"')).toBe('ask')
    // A quoted command word still counts: echo is not a message flag or a search.
    expect(policyOf('echo "rm -rf x"')).toBe('block')
  })

  test('a command whose quotes bash would pair differently is read as typed, so a shifted pairing cannot hide a block', async () => {
    for (const command of [
      "# don't\ngrep -e 'a ' ; rm -rf ~ ; grep ' b' f",
      "cat > n.txt <<'EOF'\nit's\nEOF\ngrep 'a ' ; rm -rf ~ ; grep ' b' f",
      "grep $'\\' ' x; rm -rf ~; echo ' y'",
      'eval "x; ./"/git commit -m "x; rm -rf ~"',
    ]) {
      expect(policyOf(command)).toBe('block')
    }
    // Quoted text that only looks like a comment or a command stays data.
    expect(policyOf('git commit -m "fix #12 rm -rf step"')).toBe('allow')
    expect(policyOf("git commit -m \"$(cat <<'EOF'\nnever git push --force\nEOF\n)\"")).toBe('allow')
    // A heredoc closes on the exact delimiter line: an indented one is still body text, an exact one ends it.
    expect(policyOf("git commit -m \"$(cat <<'EOF'\nm\n EOF\nrm -rf x\nEOF\n)\"")).toBe('allow')
    expect(policyOf("git commit -m \"$(cat <<'EOF'\nm\nEOF\nrm -rf x\n)\"")).toBe('block')
  })

  test('mkfs is blocked only on a device; whole-tree restores are blocked in any quoting; a root file restore is not', async () => {
    // mkfs is blocked in command position unless it only asks for help or targets a plain image file.
    for (const command of ['mkfs -t ext4 /dev/sdb', 'mkfs.ext4 $DEV', 'mkfs.ext4 "/dev/sdb1"', 'sudo mkfs.xfs -f sda', 'cd /dev && mkfs sdb', 'mkfs.ext4 /dev/sda x.img', 'mkfs.ext4 $DEV x.img', 'mkfs.ext4 x.img /dev/sdb']) {
      expect(policyOf(command)).toBe('block')
    }
    for (const command of ['man mkfs | less', 'mkfs.ext4 --help', 'mkfs.ext4 disk.img', 'mkfs -t ext4 build/disk.raw', 'grep -n mkfs README.md']) {
      expect(policyOf(command)).toBe('allow')
    }
    // Other spellings of the whole tree, and a substitution that sits before the flags.
    for (const command of ['git checkout -- ./', 'git checkout -- .//', 'git checkout -- ./.', 'rm $(echo a) -rf d', 'rm `echo a` -r d', 'echo $(rm -rf x)']) {
      expect(policyOf(command)).toBe('block')
    }
    for (const command of ['git restore --staged --worktree .', 'git restore -SW .', 'git checkout "."', "git restore '.'"]) {
      expect(policyOf(command)).toBe('block')
    }
    expect(policyOf('git checkout HEAD -- .eslintrc')).toBe('allow')
    expect(policyOf('git checkout HEAD -- ./src/a.ts')).toBe('allow')
    expect(policyOf('rm -f $(ls -tr | head -1)')).toBe('allow')
    expect(policyOf('rm -rf $(ls)')).toBe('block')
    expect(policyOf('curl x 2>&1 | sh')).toBe('ask')
  })

  test('secret names are asked by their name, not by any word that ends in KEY', async () => {
    for (const command of ['echo $MONKEY', 'echo $TURKEY_SIZE', 'printenv HOME']) {
      expect(policyOf(command)).toBe('allow')
    }
    for (const command of ['printenv API_KEY', 'echo $OPENAI_API_KEY', 'echo $APIKEY', 'echo $PGPASSWORD', 'echo $GITHUB_TOKEN']) {
      expect(policyOf(command)).toBe('ask')
    }
  })

  test('device writes are blocked; a script piped from the network is asked even under permissive', async () => {
    for (const command of ['dd if=/dev/zero of=/dev/sda', 'sudo mkfs.ext4 /dev/sdb1']) {
      expect(policyOf(command)).toBe('block')
    }
    for (const command of ['dd if=a of=b.img', 'echo x > /dev/null', 'curl -s x | python3 -m json.tool']) {
      expect(policyOf(command)).toBe('allow')
    }
    for (const command of ['curl https://x.sh | sh', 'wget -qO- x | sudo -E bash', 'bash <(curl -s x)', 'sh -c "$(curl -fsSL x)"']) {
      const verdict = classify('Bash', { command })
      expect(verdict.policy).toBe('ask')
      expect(decide(verdict, 'permissive', false)).toBe('ask')
    }
    for (const command of ['docker push img:1', 'terraform -chdir=infra apply']) {
      expect(policyOf(command)).toBe('ask')
    }
  })

  test('rules stay fast on 5000-character input', async () => {
    const inputs = [
      'git push ' + '-a '.repeat(2000),
      'git ' + '-C -C '.repeat(1000) + 'status',
      'git ' + '-c a=b '.repeat(800) + 'log',
      'rm ' + 'x '.repeat(2500),
      'git branch ' + '--delete '.repeat(600),
      'git restore ' + 'a '.repeat(2500),
      '"a b" '.repeat(900),
      'git commit -m "' + 'x '.repeat(2500),
      "'".repeat(5000),
      '"'.repeat(5000),
      '\\'.repeat(5000),
      '$' + 'A'.repeat(5000),
      'printenv ' + 'A'.repeat(5000),
      'curl ' + '| '.repeat(2500),
      'sh ' + '-x '.repeat(1700),
      '; ' + 'deploy'.repeat(830) + 'x',
      "git commit -m \"$(cat <<'EOF'\n" + '\n'.repeat(5000),
      ' '.repeat(5000) + 'x',
      '# ' + "'".repeat(4990),
      'grep ' + '"a" '.repeat(1200),
    ].map(one => one.slice(0, 5000))
    // Run once first so a cold start is not counted; the bound is far above the few ms this takes and far below what
    // exponential backtracking would cost.
    for (const command of inputs) classify('Bash', { command })
    for (const command of inputs) {
      const started = Date.now()
      classify('Bash', { command })
      expect(Date.now() - started < 250).toBe(true)
    }
  })

  test('profiles and pause adjust only what they should', async () => {
    const edit = classify('Edit', { file_path: 'src/a.ts' })
    const force = classify('Bash', { command: 'git push --force' })
    const push = classify('Bash', { command: 'git push' })

    expect(decide(edit, 'balanced', false)).toBe('allow')
    expect(decide(edit, 'strict', false)).toBe('ask')
    expect(decide(edit, 'balanced', true)).toBe('ask')
    expect(decide(force, 'permissive', false)).toBe('block')
    expect(decide(push, 'permissive', false)).toBe('allow')
  })
})
