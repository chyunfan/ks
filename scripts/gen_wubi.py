# -*- coding: utf-8 -*-
"""
生成 src/wubi.js —— 打字练习用的五笔86 单字码表。

来源：rime/rime-wubi 的 wubi86.dict.yaml（已下载到打字练习工程目录）
输出：紧凑的「字+编码」串，运行时 split 一次建索引，避免把 27k 条
      对象字面量写进源码（那样 bundle 会大出一倍多）。

用法：python scripts/gen_wubi.py
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = r"E:\Program Files\MyWorkBuddy\2026-09-28-09-40-59\typing-practice\wubi86.dict.yaml"
OUT = os.path.join(ROOT, "src", "wubi.js")


def is_cjk(ch):
    o = ord(ch)
    return (0x3400 <= o <= 0x9FFF) or (0xF900 <= o <= 0xFAFF)


def parse():
    wubi = {}
    started = False
    with open(SRC, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.strip() == "...":
                started = True
                continue
            if not started or not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            text, code = parts[0].strip(), parts[1].strip()
            # 只收单字（CJK 基本区/兼容区），编码限定 a-z
            if len(text) == 1 and is_cjk(text) and re.fullmatch(r"[a-z]+", code or ""):
                if text not in wubi:
                    wubi[text] = code
    return wubi


def main():
    wubi = parse()
    # 单行紧凑格式：「字码 字码 字码 …」，字与码都不含空格
    packed = " ".join(ch + code for ch, code in wubi.items())
    header = (
        "// ============================================================\n"
        "// 五笔86 单字码表（%d 字）· 由 scripts/gen_wubi.py 生成，请勿手改\n"
        "// 数据来源：rime/rime-wubi 的 wubi86.dict.yaml\n"
        "// 格式：字 + 编码，空格分隔；运行时解析为 { 字: 编码 }\n"
        "// ============================================================\n" % len(wubi)
    )
    body = (
        "const PACKED = '%s';\n\n"
        "const WUBI = Object.create(null);\n"
        "for (const item of PACKED.split(' ')) {\n"
        "  if (item.length > 1) WUBI[item[0]] = item.slice(1);\n"
        "}\n\n"
        "export { WUBI };\n" % packed
    )
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + body)
    print("entries:", len(wubi))
    print("output bytes:", os.path.getsize(OUT))
    for ch in ["打", "字", "练", "习", "的", "血", "敢"]:
        print(ch, "->", wubi.get(ch, "MISS"))


if __name__ == "__main__":
    main()
