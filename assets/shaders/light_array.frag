#version 330 core

/*
Problem: These shaders are static, cannot take in data from outside, cannot change their behaviour except if we changed the code.
Ex: if we had a triangle, we cannot move it except if we changed the code.
Therefore we want to find a way to communicate between our code that runs on the CPU and the shaders that run on the GPU.
Types of variables that create this link are: uniforms and attributes. 
*/

/*
Uniforms should be used for values that change relatively rarely. (Ideally at most once per frame.)
Attributes should be used for values that change frequently.
*/

in Varyings {
    vec4 color;
    vec2 tex_coord;
    vec3 normal;
    vec3 view;
    vec3 world;
} fsin;

// These type constants match their peers in the C++ code.
#define TYPE_DIRECTIONAL    0
#define TYPE_POINT          1
#define TYPE_SPOT           2

// Now we will use a single struct for all light types.
struct Light {
    // This will hold the light type.
    int type;
    // This defines the color and intensity of the light.
    // Note that we no longer define different values for the diffuse and the specular because it is unrealistic.
    // Also, we skipped the ambient and we will use a sky light instead.
    vec3 color;

    // Position is used for point and spot lights. Direction is used for directional and spot lights.
    vec3 position, direction;
    // Attentuation factors are used for point and spot lights.
    float attenuation_constant;
    float attenuation_linear;
    float attenuation_quadratic;
    // Cone angles are used for spot lights.
    float inner_angle, outer_angle;
};

// The sky light will allow us to vary the ambient light based on the surface normal which is slightly more realistic compared to constant ambient lighting.
struct SkyLight {
    vec3 top_color, middle_color, bottom_color;
};

// This will be used to compute the diffuse factor.
float calculate_lambert(vec3 normal, vec3 light_direction){
    return max(0.0f, dot(normal, -light_direction));
}

// This will be used to compute the phong specular.
float calculate_phong(vec3 normal, vec3 light_direction, vec3 view, float shininess){
    vec3 reflected = reflect(light_direction, normal);
    return pow(max(0.0f, dot(view, reflected)), shininess);
}


// This contains all the material properties for a single pixel.
// We have an extra property "emissive" which is used when the pixel itself emits light.
struct Material {
    vec3 diffuse;
    vec3 specular;
    vec3 ambient;
    vec3 emissive;
    float shininess;
};

// This contains all the material properties and texture maps for the object.
struct TexturedMaterial {
    sampler2D albedo_map; //how dark or bright the object is
    vec3 albedo_tint;
    sampler2D specular_map; //shinness of the object
    vec3 specular_tint;
    sampler2D ambient_occlusion_map; //used to calculate how exposed each point in a scene is to ambient lighting
    sampler2D roughness_map;
    vec2 roughness_range;
    sampler2D emissive_map;
    vec3 emissive_tint;
};

// This function samples the texture maps from the textured material and calculates the equivalent material at the given texture coordinates.
Material sample_material(TexturedMaterial tex_mat, vec2 tex_coord){
    Material mat;
    // Albedo is used to sample the diffuse
    mat.diffuse = tex_mat.albedo_tint * texture(tex_mat.albedo_map, tex_coord).rgb;
    // Specular is used to sample the specular... obviously
    mat.specular = tex_mat.specular_tint * texture(tex_mat.specular_map, tex_coord).rgb;
    // Emissive is used to sample the Emissive... once again "obviously"
    mat.emissive = tex_mat.emissive_tint * texture(tex_mat.emissive_map, tex_coord).rgb;
    // Ambient is computed by multiplying the diffuse by the ambient occlusion factor. This allows occluded crevices to look darker.
    mat.ambient = mat.diffuse * texture(tex_mat.ambient_occlusion_map, tex_coord).r;

    // Roughness is used to compute the shininess (specular power).
    float roughness = mix(tex_mat.roughness_range.x, tex_mat.roughness_range.y,
        texture(tex_mat.roughness_map, tex_coord).r);
    // We are using a formula designed the Blinn-Phong model which is a popular approximation of the Phong model.
    // The source of the formula is http://graphicrants.blogspot.com/2013/08/specular-brdf-reference.html
    // It is noteworthy that we clamp the roughness to prevent its value from ever becoming 0 or 1 to prevent lighting artifacts.
    mat.shininess = 2.0f/pow(clamp(roughness, 0.001f, 0.999f), 4.0f) - 2.0f;

    return mat;
}

// This will define the maximum number of lights we can receive.
#define MAX_LIGHT_COUNT 16

// Now we recieve the material, light array, the actual number of lights sent from the cpu and the sky light.
uniform TexturedMaterial material;
uniform Light lights[MAX_LIGHT_COUNT];
uniform int light_count;
uniform SkyLight sky_light;

out vec4 frag_color;



void main() {
    // First, we sample the material at the current pixel.
    Material sampled = sample_material(material, fsin.tex_coord);

    // Then we normalize the normal and the view. These are done once and reused for every light type.
    vec3 normal = normalize(fsin.normal); // Although the normal was already normalized, it may become shorter during interpolation.
    vec3 view = normalize(fsin.view);

    // We calcuate the ambient using the sky light and the surface normal.
    vec3 ambient = sampled.ambient * (normal.y > 0 ?
        mix(sky_light.middle_color, sky_light.top_color, normal.y) :
        mix(sky_light.middle_color, sky_light.bottom_color, -normal.y));

    // Initially the accumulated light will hold the ambient light and the emissive light (light coming out of the object).
    vec3 accumulated_light = sampled.emissive + ambient;

    // Make sure that the actual light count never exceeds the maximum light count.
    int count = min(light_count, MAX_LIGHT_COUNT);
    // Now we will loop over all the lights.
    for(int index = 0; index < count; index++){
        Light light = lights[index];
        vec3 light_direction;
        float attenuation = 1;
        if(light.type == TYPE_DIRECTIONAL)
            light_direction = light.direction; // If light is directional, use its direction as the light direction
        else {
            // If not directional, compute the direction from the position.
            light_direction = fsin.world - light.position;
            float distance = length(light_direction);
            light_direction /= distance;

            // And compute the attenuation.
            attenuation *= 1.0f / (light.attenuation_constant +
            light.attenuation_linear * distance +
            light.attenuation_quadratic * distance * distance);

            if(light.type == TYPE_SPOT){
                // If it is a spot light, comput the angle attenuation.
                float angle = acos(dot(light.direction, light_direction));
                attenuation *= smoothstep(light.outer_angle, light.inner_angle, angle);
            }
        }

        // Now we compute the 2 components of the light separately.
        vec3 diffuse = sampled.diffuse * light.color * calculate_lambert(normal, light_direction);
        vec3 specular = sampled.specular * light.color * calculate_phong(normal, light_direction, view, sampled.shininess);

        // Then we accumulate the light components additively.
        accumulated_light += (diffuse + specular) * attenuation;
    }

    frag_color = fsin.color * vec4(accumulated_light, 1.0f);
}
