import openApiSpecUrl from "./openapi.yml?url";

window.addEventListener("load", () => {
  SwaggerUIBundle({
    url: openApiSpecUrl,
    dom_id: "#swagger-ui",
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
    docExpansion: "none",
  });
});
