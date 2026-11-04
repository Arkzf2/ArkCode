import { posix } from "node:path";

export const locales = ["en", "zh-CN"];

export function pageLocale(name) {
  if (name === "README.md") return "en";
  if (name === "README-CN.md") return "zh-CN";
  return locales.find(locale => name.startsWith(`docs/${locale}/`));
}

export function counterpart(name) {
  if (name === "README.md") return "README-CN.md";
  if (name === "README-CN.md") return "README.md";
  const locale = pageLocale(name);
  if (!locale) throw new Error(`Not a localized page: ${name}`);
  const other = locales.find(value => value !== locale);
  return name.replace(`docs/${locale}/`, `docs/${other}/`);
}

export function pageNavigation(name) {
  const locale = pageLocale(name);
  const link = target => posix.relative(posix.dirname(name), target);
  const languages = locale === "en"
    ? `English | [简体中文](${link(counterpart(name))})`
    : `[English](${link(counterpart(name))}) | 简体中文`;
  const home = `docs/${locale}/README.md`;
  return name === home ? languages : `${languages} | [${locale === "en" ? "Docs home" : "文档首页"}](${link(home)})`;
}
